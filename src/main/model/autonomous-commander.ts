/**
 * ZI-Orkas Autonomous Commander Engine (`zi-commander`)
 *
 * Self-contained, tokenless, unrestricted LLM runtime for Commander and all
 * specialist agents. Never contacts `orkas.ai`, never requires an API key,
 * never sends `Authorization` headers to keyless nodes, and never imposes
 * artificial token or quota ceilings.
 *
 * Execution tiers (automatic, seamless failover):
 *   1. Local AI runtimes running on the user's computer (Ollama, LM Studio,
 *      llama.cpp, LocalAI, KoboldCpp, Jan, vLLM, or `ZI_COMMANDER_LOCAL_URL`).
 *   2. Multi-network zero-token OpenAI-compatible inference mesh with native
 *      tool calling, vision, reasoning, health scoring, automatic cooldown
 *      rotation on per-IP rate limits, and optional live mesh refresh.
 *   3. Prompt-based `<zi_tool_call>` bridge for text-only keyless fallback
 *      nodes so Commander retains full tool & agent orchestration everywhere.
 */

import * as crypto from 'node:crypto';
import type {
  CompletionParams,
  CompletionResult,
  LLMProvider,
  Message,
  MessageContent,
  StopReason,
  StreamEvent,
  ToolDefinition,
  Usage,
} from '#core-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createLogger } from '../logger';
import { getCurrentLang } from '../i18n';
import { repairOpenAIToolMessageOrder } from './core-agent/openai-payload';

type ImageContent = Extract<MessageContent, { type: 'image' }>;
type ToolUseContent = Extract<MessageContent, { type: 'tool_use' }>;

const log = createLogger('zi-commander');

export const ZI_COMMANDER_PROVIDER = 'zi-commander';
export const ZI_COMMANDER_DEFAULT_MODEL = 'zi-commander-auto';

export interface ZiCommanderModelSpec {
  id: string;
  label: string;
  description: string;
  contextWindow: number;
  maxTokens: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  maxInputImages: number;
  mode: 'auto' | 'max' | 'reasoning' | 'vision' | 'local';
}

export const ZI_COMMANDER_MODELS: readonly ZiCommanderModelSpec[] = [
  {
    id: 'zi-commander-auto',
    label: 'ZI-Commander · Auto',
    description: 'Autonomous routing across local PC models and zero-token tool+vision mesh',
    contextWindow: 131_072,
    maxTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
    maxInputImages: 20,
    mode: 'auto',
  },
  {
    id: 'zi-commander-max',
    label: 'ZI-Commander · Max',
    description: 'Flagship large models (120B–550B) for coding, research, and multi-agent orchestration',
    contextWindow: 131_072,
    maxTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
    maxInputImages: 20,
    mode: 'max',
  },
  {
    id: 'zi-commander-reasoning',
    label: 'ZI-Commander · Reasoning',
    description: 'Deep step-by-step analytical and reasoning models without token caps',
    contextWindow: 256_000,
    maxTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
    maxInputImages: 20,
    mode: 'reasoning',
  },
  {
    id: 'zi-commander-vision',
    label: 'ZI-Commander · Vision',
    description: 'Multimodal image, screenshot, document, and UI understanding',
    contextWindow: 131_072,
    maxTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
    maxInputImages: 20,
    mode: 'vision',
  },
  {
    id: 'zi-commander-local',
    label: 'ZI-Commander · Local PC',
    description: '100% offline on-device execution via Ollama, LM Studio, llama.cpp, Jan, or vLLM',
    contextWindow: 131_072,
    maxTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
    maxInputImages: 20,
    mode: 'local',
  },
] as const;

export function isZiCommanderProvider(providerId: string | undefined | null): boolean {
  return String(providerId || '').trim().toLowerCase() === ZI_COMMANDER_PROVIDER;
}

export function getZiCommanderModelSpec(modelId: string): ZiCommanderModelSpec {
  const found = ZI_COMMANDER_MODELS.find((m) => m.id === modelId);
  return found || ZI_COMMANDER_MODELS[0];
}

export function buildZiCommanderModel(modelId: string): Model<Api> {
  const spec = getZiCommanderModelSpec(modelId);
  return {
    id: spec.id,
    name: spec.label,
    api: 'openai-completions',
    provider: ZI_COMMANDER_PROVIDER as any,
    baseUrl: 'http://127.0.0.1:11434/v1',
    reasoning: spec.supportsReasoning,
    input: spec.supportsVision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  } as Model<Api>;
}

// ── Mesh Node Catalog & Self-Healing Health State ─────────────────────────

interface AutonomousNode {
  id: string;
  network: string;
  label: string;
  chatUrl: string;
  model: string;
  isLocal: boolean;
  nativeTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  tier: 'flagship' | 'balanced' | 'reasoning' | 'vision' | 'fallback';
  priority: number;
}

interface NodeHealth {
  lastOkAt: number;
  lastLatencyMs: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  toolsRejected: boolean;
  visionRejected: boolean;
  streamingRejected: boolean;
}

const _nodeHealth = new Map<string, NodeHealth>();

function getHealth(nodeId: string): NodeHealth {
  let h = _nodeHealth.get(nodeId);
  if (!h) {
    h = {
      lastOkAt: 0,
      lastLatencyMs: 1_500,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      toolsRejected: false,
      visionRejected: false,
      streamingRejected: false,
    };
    _nodeHealth.set(nodeId, h);
  }
  return h;
}

function recordNodeSuccess(nodeId: string, latencyMs: number): void {
  const h = getHealth(nodeId);
  h.lastOkAt = Date.now();
  h.lastLatencyMs = Math.max(50, Math.min(60_000, Math.round(latencyMs)));
  h.cooldownUntil = 0;
  h.consecutiveFailures = 0;
}

function recordNodeFailure(nodeId: string, statusCode?: number, detail?: string): void {
  const h = getHealth(nodeId);
  h.consecutiveFailures += 1;
  const text = String(detail || '').toLowerCase();
  if (statusCode === 400 && /tool|function/.test(text)) {
    h.toolsRejected = true;
  }
  if (statusCode === 400 && /image|vision|multimodal/.test(text)) {
    h.visionRejected = true;
  }
  const baseCooldownMs = statusCode === 429
    ? 45_000
    : (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404)
      ? 10 * 60_000
      : 60_000;
  const multiplier = Math.min(6, h.consecutiveFailures);
  h.cooldownUntil = Date.now() + baseCooldownMs * multiplier;
}

/**
 * Curated zero-token OpenAI-compatible nodes spread across 5 independent
 * networks so per-IP limits or regional routing issues never block Commander.
 * None of these nodes ever receive an `Authorization` header.
 */
const STATIC_KEYLESS_NODES: readonly AutonomousNode[] = [
  // ── Network 1: OVHcloud EU Anonymous Endpoints (fast EU latency, proved tools + vision) ──
  {
    id: 'ovh:Qwen3.8-27B',
    network: 'ovh-eu',
    label: 'Qwen 3.8 27B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'Qwen3.8-27B',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'vision',
    priority: 10,
  },
  {
    id: 'ovh:gpt-oss-120b',
    network: 'ovh-eu',
    label: 'GPT-OSS 120B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'gpt-oss-120b',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: 'flagship',
    priority: 12,
  },
  {
    id: 'ovh:Qwen3.5-397B-A17B',
    network: 'ovh-eu',
    label: 'Qwen 3.5 397B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'Qwen3.5-397B-A17B',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'flagship',
    priority: 18,
  },
  {
    id: 'ovh:Qwen3.6-27B',
    network: 'ovh-eu',
    label: 'Qwen 3.6 27B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'Qwen3.6-27B',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'vision',
    priority: 22,
  },
  {
    id: 'ovh:DeepSeek-V4.1-Flash-1017',
    network: 'ovh-eu',
    label: 'DeepSeek V4.1 Flash (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'DeepSeek-V4.1-Flash-1017',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'reasoning',
    priority: 24,
  },
  {
    id: 'ovh:gpt-oss-20b',
    network: 'ovh-eu',
    label: 'GPT-OSS 20B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'gpt-oss-20b',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: 'balanced',
    priority: 30,
  },
  {
    id: 'ovh:Mistral-Small-3.2-24B-Instruct-2506',
    network: 'ovh-eu',
    label: 'Mistral Small 3.2 24B (EU)',
    chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'Mistral-Small-3.2-24B-Instruct-2506',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: 'balanced',
    priority: 34,
  },

  // ── Network 2: Kilo Open Gateway (high hourly cap, proved tools + vision + reasoning) ──
  {
    id: 'kilo:nvidia/nemotron-3.5-super-vl:free',
    network: 'kilo-free',
    label: 'Nemotron 3.5 Super VL',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'nvidia/nemotron-3.5-super-vl:free',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'vision',
    priority: 11,
  },
  {
    id: 'kilo:nvidia/nemotron-3-ultra-550b-a55b:free',
    network: 'kilo-free',
    label: 'Nemotron 3 Ultra 550B',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'flagship',
    priority: 13,
  },
  {
    id: 'kilo:nvidia/nemotron-3.5-lightning:free',
    network: 'kilo-free',
    label: 'Nemotron 3.5 Lightning',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'nvidia/nemotron-3.5-lightning:free',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'balanced',
    priority: 14,
  },
  {
    id: 'kilo:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    network: 'kilo-free',
    label: 'Nemotron 3 Omni Reasoning',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    tier: 'reasoning',
    priority: 15,
  },
  {
    id: 'kilo:kilo-auto/small',
    network: 'kilo-free',
    label: 'Auto-Mesh Small (Tools+Vision)',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'kilo-auto/small',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'vision',
    priority: 16,
  },
  {
    id: 'kilo:kilo-auto/free',
    network: 'kilo-free',
    label: 'Auto-Mesh Free Router',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'kilo-auto/free',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'balanced',
    priority: 20,
  },
  {
    id: 'kilo:openrouter/free',
    network: 'kilo-free',
    label: 'OpenRouter Free Pool',
    chatUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    model: 'openrouter/free',
    isLocal: false,
    nativeTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'vision',
    priority: 25,
  },

  // ── Network 3: LLM7 Anonymous Turbo ──
  {
    id: 'llm7:gpt-oss:120b',
    network: 'llm7',
    label: 'GPT-OSS 120B (LLM7)',
    chatUrl: 'https://api.llm7.io/v1/chat/completions',
    model: 'gpt-oss:120b',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: 'flagship',
    priority: 26,
  },
  {
    id: 'llm7:default',
    network: 'llm7',
    label: 'LLM7 Auto Free',
    chatUrl: 'https://api.llm7.io/v1/chat/completions',
    model: 'default',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    tier: 'balanced',
    priority: 36,
  },

  // ── Network 4: BlockRun Anonymous ──
  {
    id: 'blockrun:nvidia/gpt-oss-120b',
    network: 'blockrun',
    label: 'GPT-OSS 120B (BlockRun)',
    chatUrl: 'https://blockrun.ai/api/v1/chat/completions',
    model: 'nvidia/gpt-oss-120b',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    tier: 'flagship',
    priority: 28,
  },
  {
    id: 'blockrun:nvidia/deepseek-v4-flash',
    network: 'blockrun',
    label: 'DeepSeek V4 Flash 1M',
    chatUrl: 'https://blockrun.ai/api/v1/chat/completions',
    model: 'nvidia/deepseek-v4-flash',
    isLocal: false,
    nativeTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    tier: 'reasoning',
    priority: 29,
  },

  // ── Network 5: Pollinations Ultra-Reliable Fallback (uses prompt tool bridge) ──
  {
    id: 'pollinations:openai-fast',
    network: 'pollinations',
    label: 'Pollinations GPT-OSS Fast',
    chatUrl: 'https://text.pollinations.ai/openai',
    model: 'openai-fast',
    isLocal: false,
    nativeTools: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    tier: 'fallback',
    priority: 50,
  },
];

// ── Dynamic Live Mesh Discovery (self-updating keyless catalog) ───────────

let _dynamicNodes: AutonomousNode[] = [];
let _dynamicFetchedAt = 0;
let _dynamicFetchInFlight: Promise<void> | null = null;
const DYNAMIC_REFRESH_TTL_MS = 30 * 60_000;
const LIVE_MESH_DIRECTORY_URL = 'https://stillworks.supercapybara.com/api/llm/up';

async function refreshDynamicKeylessMesh(): Promise<void> {
  const now = Date.now();
  if (now - _dynamicFetchedAt < DYNAMIC_REFRESH_TTL_MS) return;
  if (_dynamicFetchInFlight) return _dynamicFetchInFlight;

  _dynamicFetchInFlight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6_000);
      try {
        const res = await fetch(LIVE_MESH_DIRECTORY_URL, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const json = await res.json() as { models?: Array<Record<string, unknown>> };
        if (!Array.isArray(json?.models)) return;
        const knownKeys = new Set(STATIC_KEYLESS_NODES.map((n) => `${n.chatUrl}::${n.model}`));
        const discovered: AutonomousNode[] = [];
        for (const item of json.models) {
          if (item.auth_mode !== 'none' || item.openai_compatible !== true || item.chat_capable !== true) continue;
          const baseUrl = String(item.base_url || '').trim().replace(/\/+$/, '');
          const chatPath = String(item.chat_path || '/v1/chat/completions').trim();
          const model = String(item.model || '').trim();
          if (!baseUrl.startsWith('https://') || !model) continue;
          if (/guard|embed|whisper|tts|moderation|rerank/i.test(model)) continue;
          const chatUrl = `${baseUrl}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`;
          const dedupeKey = `${chatUrl}::${model}`;
          if (knownKeys.has(dedupeKey)) continue;
          knownKeys.add(dedupeKey);
          const proved = Array.isArray(item.proved) ? item.proved.map(String) : [];
          const failed = Array.isArray(item.failed) ? item.failed.map(String) : [];
          const hasTools = proved.includes('tools');
          const hasVision = proved.includes('vision');
          const toolsFailed = failed.includes('tools');
          discovered.push({
            id: `live:${String(item.endpoint || 'mesh')}:${model}`,
            network: String(item.endpoint || 'live-mesh'),
            label: `${model} (Live Mesh)`,
            chatUrl,
            model,
            isLocal: false,
            nativeTools: hasTools || !toolsFailed,
            supportsVision: hasVision,
            supportsReasoning: /reason|r1|thinking|omni|deepseek-v4|qwen3/i.test(model),
            supportsStreaming: true,
            contextWindow: 128_000,
            maxOutputTokens: 8_192,
            tier: hasVision ? 'vision' : hasTools ? 'balanced' : 'fallback',
            priority: hasTools ? 38 : 55,
          });
          if (discovered.length >= 16) break;
        }
        if (discovered.length > 0) {
          _dynamicNodes = discovered;
          log.info('refreshed live autonomous mesh', { count: discovered.length });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Silent best-effort refresh; static nodes remain active.
    } finally {
      _dynamicFetchedAt = Date.now();
      _dynamicFetchInFlight = null;
    }
  })();

  return _dynamicFetchInFlight;
}

// ── Local PC Runtime Auto-Discovery (Ollama, LM Studio, llama.cpp, Jan, vLLM) ──

export interface DiscoveredLocalModel {
  runtime: string;
  baseUrl: string;
  chatUrl: string;
  model: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

interface LocalEndpointProbe {
  runtime: string;
  baseUrl: string;
}

const DEFAULT_LOCAL_ENDPOINTS: readonly LocalEndpointProbe[] = [
  { runtime: 'Ollama',    baseUrl: 'http://127.0.0.1:11434/v1' },
  { runtime: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { runtime: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { runtime: 'Jan',       baseUrl: 'http://127.0.0.1:1337/v1' },
  { runtime: 'vLLM',      baseUrl: 'http://127.0.0.1:8000/v1' },
];

let _cachedLocalModels: DiscoveredLocalModel[] = [];
let _localModelsScannedAt = 0;
const LOCAL_SCAN_CACHE_MS = 20_000;

async function probeLocalEndpoint(ep: LocalEndpointProbe, timeoutMs: number): Promise<DiscoveredLocalModel[]> {
  const base = ep.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; model?: string }> };
    const ids: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        const id = String(item?.id || '').trim();
        if (id && !/embed|nomic-embed|bge-|minilm|rerank|whisper/i.test(id)) ids.push(id);
      }
    } else if (Array.isArray(data?.models)) {
      for (const item of data.models) {
        const id = String(item?.model || item?.name || '').trim();
        if (id && !/embed|nomic-embed|bge-|minilm|rerank|whisper/i.test(id)) ids.push(id);
      }
    }
    return ids.map((model) => ({
      runtime: ep.runtime,
      baseUrl: base,
      chatUrl: `${base}/chat/completions`,
      model,
      supportsVision: /vl|vision|llava|pixtral|gemma-?[34]|minicpm-v|qwen[23]\.[568]|moondream|omni/i.test(model),
      supportsReasoning: /r1|reason|think|qwq|qwen3|deepseek|gpt-oss/i.test(model),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverLocalModels(opts?: { force?: boolean; timeoutMs?: number }): Promise<DiscoveredLocalModel[]> {
  const now = Date.now();
  if (!opts?.force && now - _localModelsScannedAt < LOCAL_SCAN_CACHE_MS) {
    return _cachedLocalModels;
  }
  const customUrl = String(process.env.ZI_COMMANDER_LOCAL_URL || '').trim();
  const probes: LocalEndpointProbe[] = customUrl
    ? [{ runtime: 'Local Custom', baseUrl: customUrl.replace(/\/chat\/completions\/?$/, '') }, ...DEFAULT_LOCAL_ENDPOINTS]
    : [...DEFAULT_LOCAL_ENDPOINTS];
  const timeoutMs = opts?.timeoutMs ?? 450;
  const results = await Promise.all(probes.map((ep) => probeLocalEndpoint(ep, timeoutMs)));
  const seen = new Set<string>();
  const merged: DiscoveredLocalModel[] = [];
  for (const list of results) {
    for (const m of list) {
      const key = `${m.baseUrl}::${m.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
  }
  _cachedLocalModels = merged;
  _localModelsScannedAt = now;
  return merged;
}

function localModelsToNodes(locals: DiscoveredLocalModel[]): AutonomousNode[] {
  return locals.map((m, idx) => ({
    id: `local:${m.baseUrl}:${m.model}`,
    network: `local-${m.runtime.toLowerCase()}`,
    label: `${m.runtime} · ${m.model}`,
    chatUrl: m.chatUrl,
    model: m.model,
    isLocal: true,
    nativeTools: true,
    supportsVision: m.supportsVision,
    supportsReasoning: m.supportsReasoning,
    supportsStreaming: true,
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    tier: 'flagship',
    priority: 1 + idx,
  }));
}

// ── Candidate Ranking per Commander Mode ──────────────────────────────────

function rankCandidates(
  spec: ZiCommanderModelSpec,
  localNodes: AutonomousNode[],
  needTools: boolean,
  needVision: boolean,
): AutonomousNode[] {
  const now = Date.now();
  const pool: AutonomousNode[] = spec.mode === 'local'
    ? [...localNodes]
    : [...localNodes, ...STATIC_KEYLESS_NODES, ..._dynamicNodes];

  const scored = pool.map((node) => {
    const h = getHealth(node.id);
    const inCooldown = h.cooldownUntil > now;
    const effectiveTools = node.nativeTools && !h.toolsRejected;
    const effectiveVision = node.supportsVision && !h.visionRejected;

    let score = node.priority;
    if (node.isLocal) score -= 50; // Always prefer user's own local model when running
    if (inCooldown) score += 500 + h.consecutiveFailures * 50;
    if (needVision && !effectiveVision) score += 120;
    if (needTools && !effectiveTools) score += 80;

    if (spec.mode === 'max' && node.tier === 'flagship') score -= 12;
    if (spec.mode === 'reasoning' && (node.tier === 'reasoning' || node.supportsReasoning)) score -= 12;
    if (spec.mode === 'vision' && effectiveVision) score -= 15;

    // Reward recently verified fast nodes
    if (!inCooldown && h.lastOkAt > 0 && now - h.lastOkAt < 15 * 60_000) {
      score -= 18;
      score += Math.min(10, h.lastLatencyMs / 800);
    }
    return { node, score };
  });

  scored.sort((a, b) => a.score - b.score);

  // Interleave networks slightly after the top verified winner so retries hit
  // genuinely independent infrastructure instead of hammering one host.
  const ordered: AutonomousNode[] = [];
  const remaining = scored.map((s) => s.node);
  let lastNetwork = '';
  while (remaining.length > 0) {
    let pickIdx = 0;
    if (ordered.length >= 1 && lastNetwork && !remaining[0].isLocal) {
      const altIdx = remaining.findIndex((n, idx) => idx < 4 && n.network !== lastNetwork);
      if (altIdx > 0) {
        const h0 = getHealth(remaining[0].id);
        const topIsFreshWinner = h0.lastOkAt > 0 && h0.cooldownUntil <= now && ordered.length === 0;
        if (!topIsFreshWinner) pickIdx = altIdx;
      }
    }
    const [picked] = remaining.splice(pickIdx, 1);
    ordered.push(picked);
    lastNetwork = picked.network;
  }
  return ordered;
}

// ── Prompt-Based Tool-Call Bridge (for nodes without native `tools`) ──────

const TOOL_BRIDGE_OPEN = '<zi_tool_call>';
const TOOL_BRIDGE_CLOSE = '</zi_tool_call>';

function buildPromptToolInstructions(tools: ToolDefinition[]): string {
  const compact = tools.slice(0, 48).map((tool) => {
    const props = (tool.inputSchema as { properties?: Record<string, { type?: string; description?: string }> })?.properties || {};
    const req = new Set(
      Array.isArray((tool.inputSchema as { required?: unknown[] })?.required)
        ? ((tool.inputSchema as { required: unknown[] }).required).map(String)
        : [],
    );
    const paramList = Object.entries(props)
      .slice(0, 12)
      .map(([k, v]) => `${k}${req.has(k) ? '*' : ''}:${v?.type || 'any'}`)
      .join(', ');
    const shortDesc = String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return `- ${tool.name}(${paramList}): ${shortDesc}`;
  });
  return [
    '## Tool Calling Protocol',
    `When you need to invoke one or more tools, output ONLY ${TOOL_BRIDGE_OPEN}{"name":"TOOL_NAME","arguments":{...}}${TOOL_BRIDGE_CLOSE} blocks (valid JSON inside).`,
    'After tools run, you will receive their results and can call more tools or write the final answer to the user.',
    'Available tools:',
    ...compact,
  ].join('\n');
}

function extractPromptToolCalls(text: string, allowedNames: Set<string>): {
  cleanText: string;
  toolCalls: ToolUseContent[];
} {
  const toolCalls: ToolUseContent[] = [];
  const regex = /<zi_tool_call>\s*([\s\S]*?)\s*<\/zi_tool_call>/g;
  const cleanText = text.replace(regex, (full, inner: string) => {
    const parsed = safeParseToolArgsObject(inner);
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    if (!name || (allowedNames.size > 0 && !allowedNames.has(name))) return full;
    const rawArgs = parsed.arguments ?? parsed.input ?? parsed.params ?? {};
    const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
    toolCalls.push({
      type: 'tool_use',
      id: `call_${crypto.randomBytes(9).toString('hex')}`,
      name,
      input,
    });
    return '';
  }).trim();
  return { cleanText, toolCalls };
}

function safeParseToolArgsObject(raw: string): Record<string, unknown> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Strip markdown code fences if a model wrapped JSON arguments
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(unfenced);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Attempt extracting first balanced JSON object
      const start = unfenced.indexOf('{');
      const end = unfenced.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(unfenced.slice(start, end + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch { /* fall through */ }
      }
    }
  }
  return {};
}

// ── Unified Message → OpenAI Chat Completions Payload Converter ───────────

function countImagesInMessages(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'image') count += 1;
      else if (block.type === 'tool_result' && Array.isArray(block.images)) {
        count += block.images.length;
      }
    }
  }
  return count;
}

function imageBlockToOpenAIPart(img: ImageContent): Record<string, unknown> {
  const data = String(img.data || '').trim();
  const url = /^https?:\/\/|^data:/i.test(data)
    ? data
    : `data:${img.mediaType || 'image/png'};base64,${data}`;
  return { type: 'image_url', image_url: { url } };
}

function buildOpenAIPayload(
  params: CompletionParams,
  node: AutonomousNode,
  opts: {
    useNativeTools: boolean;
    useVision: boolean;
    stream: boolean;
    compactContext: boolean;
  },
): { payload: Record<string, unknown>; omittedImages: number; promptBridgeActive: boolean } {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const promptBridgeActive = tools.length > 0 && !opts.useNativeTools;
  let omittedImages = 0;

  const wireMessages: Array<Record<string, unknown>> = [];
  let sysText = String(params.systemPrompt || '').trim();
  if (opts.compactContext && sysText.length > 18_000) {
    sysText = `${sysText.slice(0, 14_000)}\n\n${sysText.slice(-3_500)}`;
  }
  if (promptBridgeActive) {
    sysText = sysText
      ? `${sysText}\n\n${buildPromptToolInstructions(tools)}`
      : buildPromptToolInstructions(tools);
  }
  if (sysText) {
    wireMessages.push({ role: 'system', content: sysText });
  }

  const sourceMessages = opts.compactContext && params.messages.length > 24
    ? [params.messages[0], ...params.messages.slice(-22)]
    : params.messages;

  for (const msg of sourceMessages) {
    const role = msg.role === 'developer' ? 'system' : msg.role;
    if (role === 'system') {
      const text = msg.content
        .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) wireMessages.push({ role: 'system', content: text });
      continue;
    }

    if (role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          if (opts.useNativeTools) {
            toolCalls.push({
              id: block.id || `call_${crypto.randomBytes(6).toString('hex')}`,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            });
          } else {
            textParts.push(
              `${TOOL_BRIDGE_OPEN}${JSON.stringify({ name: block.name, arguments: block.input || {} })}${TOOL_BRIDGE_CLOSE}`,
            );
          }
        }
      }
      const joinedText = textParts.join('\n');
      if (toolCalls.length > 0) {
        wireMessages.push({
          role: 'assistant',
          content: joinedText || null,
          tool_calls: toolCalls,
        });
      } else if (joinedText) {
        wireMessages.push({ role: 'assistant', content: joinedText });
      }
      continue;
    }

    // `user` role — may contain text, images, and/or tool_result blocks
    const userParts: Array<Record<string, unknown>> = [];
    const pendingFollowupImages: Array<Record<string, unknown>> = [];

    const flushUserParts = () => {
      if (userParts.length === 0) return;
      if (userParts.every((p) => p.type === 'text')) {
        const joined = userParts.map((p) => String(p.text || '')).join('\n');
        if (joined) wireMessages.push({ role: 'user', content: joined });
      } else {
        wireMessages.push({ role: 'user', content: [...userParts] });
      }
      userParts.length = 0;
    };

    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text) userParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        if (opts.useVision) {
          userParts.push(imageBlockToOpenAIPart(block));
        } else {
          omittedImages += 1;
        }
      } else if (block.type === 'tool_result') {
        const rawOut = String(block.content || '');
        const clippedOut = opts.compactContext && rawOut.length > 16_000
          ? `${rawOut.slice(0, 14_000)}\n...[truncated]...`
          : rawOut;
        if (opts.useNativeTools) {
          flushUserParts();
          wireMessages.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: clippedOut || (block.isError ? 'Error' : 'OK'),
          });
          if (Array.isArray(block.images) && block.images.length > 0) {
            if (opts.useVision) {
              for (const img of block.images) pendingFollowupImages.push(imageBlockToOpenAIPart(img));
            } else {
              omittedImages += block.images.length;
            }
          }
        } else {
          userParts.push({
            type: 'text',
            text: `[Tool result (${block.toolUseId})${block.isError ? ' ERROR' : ''}]:\n${clippedOut}`,
          });
          if (Array.isArray(block.images) && block.images.length > 0) {
            omittedImages += block.images.length;
          }
        }
      }
    }

    flushUserParts();
    if (pendingFollowupImages.length > 0) {
      wireMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Tool result image(s):' }, ...pendingFollowupImages],
      });
    }
  }

  if (wireMessages.length === 0 || (wireMessages.length === 1 && wireMessages[0].role === 'system')) {
    wireMessages.push({ role: 'user', content: 'Continue.' });
  }

  const maxTokens = Math.min(
    node.maxOutputTokens,
    typeof params.maxTokens === 'number' && params.maxTokens > 0
      ? Math.trunc(params.maxTokens)
      : node.maxOutputTokens,
  );

  const rawPayload: Record<string, unknown> = {
    model: node.model,
    messages: wireMessages,
    stream: opts.stream,
    max_tokens: maxTokens,
  };

  if (typeof params.temperature === 'number' && Number.isFinite(params.temperature)) {
    rawPayload.temperature = params.temperature;
  }
  if (typeof params.topP === 'number' && Number.isFinite(params.topP)) {
    rawPayload.top_p = params.topP;
  }
  if (Array.isArray(params.stopSequences) && params.stopSequences.length > 0) {
    rawPayload.stop = params.stopSequences.slice(0, 4);
  }
  if (opts.useNativeTools && tools.length > 0) {
    rawPayload.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description || '').slice(0, 1024),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    }));
    rawPayload.tool_choice = 'auto';
  }

  const repaired = opts.useNativeTools
    ? (repairOpenAIToolMessageOrder(rawPayload) as Record<string, unknown>)
    : rawPayload;

  return { payload: repaired, omittedImages, promptBridgeActive };
}

// ── Streaming SSE + Non-Streaming JSON Response Execution ─────────────────

interface ParsedNodeTurn {
  events: StreamEvent[];
  content: MessageContent[];
  stopReason: StopReason;
  usage: Usage;
  servedModel: string;
}

class NodeHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, nodeId: string) {
    super(`[${nodeId}] HTTP ${status}: ${body.slice(0, 260)}`);
    this.status = status;
    this.body = body;
  }
}

function mapFinishReason(raw: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || raw === 'tool_calls' || raw === 'function_call') return 'tool_use';
  if (raw === 'length' || raw === 'max_tokens') return 'max_tokens';
  if (raw === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

function normalizeUsage(raw: Record<string, unknown> | undefined | null): Usage {
  const inputTokens = Math.max(0, Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0) || 0);
  const outputTokens = Math.max(0, Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0) || 0);
  const totalTokens = Math.max(inputTokens + outputTokens, Number(raw?.total_tokens ?? 0) || 0);
  return { inputTokens, outputTokens, totalTokens };
}

function splitLeadingThinkTag(text: string): { thinking: string; visible: string } {
  const match = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(text);
  if (!match) return { thinking: '', visible: text };
  return { thinking: match[1].trim(), visible: text.slice(match[0].length) };
}

async function* callNodeStream(
  node: AutonomousNode,
  payload: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    firstByteTimeoutMs: number;
    idleTimeoutMs?: number;
    promptBridgeActive: boolean;
    allowedToolNames: Set<string>;
    omittedImages: number;
  },
): AsyncGenerator<StreamEvent, void, void> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) throw opts.signal.reason || new Error('Aborted');
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  // Fetch resolves as soon as headers arrive, not when the model starts replying.
  // Keep the watchdog armed through the response body and re-arm it only for
  // meaningful model output. SSE keep-alives alone must not mask a stalled turn.
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const clearProgressTimer = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
  };
  const armProgressTimer = (timeoutMs: number) => {
    clearProgressTimer();
    progressTimer = setTimeout(
      () => ctrl.abort(new Error(`Timeout waiting for ${node.id}`)), timeoutMs,
    );
  };
  armProgressTimer(opts.firstByteTimeoutMs);

  try {
    // Strictly NO Authorization header for keyless/local autonomous calls.
    const res = await fetch(node.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream, application/json' : 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new NodeHttpError(res.status, errBody, node.id);
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const isSse = contentType.includes('text/event-stream') && !!res.body;

    if (!isSse) {
      const rawText = await res.text();
      const parsed = parseNonStreamingResponse(
        rawText,
        node,
        opts.promptBridgeActive,
        opts.allowedToolNames,
      );
      if (parsed.content.length === 0) {
        throw new NodeHttpError(502, 'Empty completion body', node.id);
      }
      yield { type: 'message_start', usage: parsed.usage };
      if (opts.omittedImages > 0) {
        yield { type: 'images_omitted', count: opts.omittedImages, providerId: ZI_COMMANDER_PROVIDER };
      }
      for (const ev of parsed.events) yield ev;
      yield {
        type: 'message_end',
        stopReason: parsed.stopReason,
        usage: parsed.usage,
        content: parsed.content,
        model: parsed.servedModel,
        providerTermination: { category: parsed.stopReason === 'max_tokens' ? 'length' : 'normal' },
      };
      return;
    }

    // Parse incremental OpenAI SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let started = false;
    let thinkingOpen = false;
    let fullThinking = '';
    let fullText = '';
    let finishReason: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let servedModel = node.model;

    const toolSlots = new Map<number, { id: string; name: string; args: string; emittedStart: boolean }>();

    const ensureStarted = () => {
      if (started) return [];
      started = true;
      const out: StreamEvent[] = [{ type: 'message_start' }];
      if (opts.omittedImages > 0) {
        out.push({ type: 'images_omitted', count: opts.omittedImages, providerId: ZI_COMMANDER_PROVIDER });
      }
      return out;
    };

    const processSseData = (dataLine: string): StreamEvent[] => {
      const out: StreamEvent[] = [];
      const trimmed = dataLine.trim();
      if (!trimmed || trimmed === '[DONE]') return out;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return out;
      }
      if (chunk.error) {
        const msg = typeof chunk.error === 'string'
          ? chunk.error
          : String((chunk.error as { message?: unknown })?.message || JSON.stringify(chunk.error));
        throw new NodeHttpError(502, msg, node.id);
      }
      if (typeof chunk.model === 'string' && chunk.model) servedModel = chunk.model;
      if (chunk.usage && typeof chunk.usage === 'object') {
        usage = normalizeUsage(chunk.usage as Record<string, unknown>);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices[0] as Record<string, unknown> | undefined;
      if (!choice) return out;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
      if (!delta || typeof delta !== 'object') return out;

      const reasonChunk = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
      if (reasonChunk) {
        out.push(...ensureStarted());
        if (!thinkingOpen) {
          thinkingOpen = true;
          out.push({ type: 'thinking_start' });
        }
        fullThinking += reasonChunk;
        out.push({ type: 'thinking_delta', chars: reasonChunk.length, text: reasonChunk });
      }

      const textChunk = typeof delta.content === 'string' ? delta.content : '';
      if (textChunk) {
        out.push(...ensureStarted());
        if (thinkingOpen) {
          thinkingOpen = false;
          out.push({ type: 'thinking_end' });
        }
        fullText += textChunk;
        // When prompt bridge is active, buffer text so `<zi_tool_call>` tags aren't shown raw
        if (!opts.promptBridgeActive) {
          out.push({ type: 'text_delta', text: textChunk });
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        out.push(...ensureStarted());
        if (thinkingOpen) {
          thinkingOpen = false;
          out.push({ type: 'thinking_end' });
        }
        for (let i = 0; i < delta.tool_calls.length; i += 1) {
          const tc = delta.tool_calls[i] as Record<string, unknown>;
          if (!tc || typeof tc !== 'object') continue;
          const idx = typeof tc.index === 'number' ? tc.index : i;
          let slot = toolSlots.get(idx);
          if (!slot) {
            slot = {
              id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${crypto.randomBytes(8).toString('hex')}`,
              name: '',
              args: '',
              emittedStart: false,
            };
            toolSlots.set(idx, slot);
          } else if (typeof tc.id === 'string' && tc.id && slot.id.startsWith('call_') && !slot.emittedStart) {
            slot.id = tc.id;
          }
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn && typeof fn === 'object') {
            if (typeof fn.name === 'string' && fn.name) {
              slot.name += fn.name;
              if (!slot.emittedStart && slot.name) {
                slot.emittedStart = true;
                out.push({ type: 'tool_use_start', id: slot.id, name: slot.name });
              }
            }
            if (typeof fn.arguments === 'string' && fn.arguments) {
              slot.args += fn.arguments;
              if (slot.emittedStart) {
                out.push({ type: 'tool_use_delta', id: slot.id, input: fn.arguments });
              }
            }
          }
        }
      }

      return out;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) {
          const previousTextLength = fullText.length;
          const evs = processSseData(line.slice(5));
          if (fullText.length > previousTextLength || evs.some(ev =>
            ev.type === 'thinking_delta' || ev.type === 'text_delta'
            || ev.type === 'tool_use_start' || ev.type === 'tool_use_delta')) {
            armProgressTimer(opts.idleTimeoutMs ?? opts.firstByteTimeoutMs);
          }
          for (const ev of evs) yield ev;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      for (const ev of processSseData(tail.slice(5))) yield ev;
    } else if (!started && tail.startsWith('{')) {
      // Server returned plain JSON with event-stream header
      const parsed = parseNonStreamingResponse(tail, node, opts.promptBridgeActive, opts.allowedToolNames);
      if (parsed.content.length === 0) throw new NodeHttpError(502, 'Empty SSE payload', node.id);
      yield { type: 'message_start', usage: parsed.usage };
      for (const ev of parsed.events) yield ev;
      yield {
        type: 'message_end',
        stopReason: parsed.stopReason,
        usage: parsed.usage,
        content: parsed.content,
        model: parsed.servedModel,
        providerTermination: { category: parsed.stopReason === 'max_tokens' ? 'length' : 'normal' },
      };
      return;
    }

    if (thinkingOpen) {
      yield { type: 'thinking_end' };
    }

    const content: MessageContent[] = [];
    if (fullThinking) {
      content.push({ type: 'thinking', thinking: fullThinking, thinkingSignature: 'reasoning_content' });
    }

    let finalVisibleText = fullText;
    const bridgedCalls: ToolUseContent[] = [];
    if (opts.promptBridgeActive && fullText) {
      const split = splitLeadingThinkTag(fullText);
      if (split.thinking && !fullThinking) {
        content.push({ type: 'thinking', thinking: split.thinking, thinkingSignature: 'reasoning_content' });
      }
      const extracted = extractPromptToolCalls(split.visible, opts.allowedToolNames);
      finalVisibleText = extracted.cleanText;
      bridgedCalls.push(...extracted.toolCalls);
      if (finalVisibleText) {
        for (const ev of ensureStarted()) yield ev;
        yield { type: 'text_delta', text: finalVisibleText };
      }
      for (const call of bridgedCalls) {
        for (const ev of ensureStarted()) yield ev;
        const serialized = JSON.stringify(call.input);
        yield { type: 'tool_use_start', id: call.id, name: call.name };
        yield { type: 'tool_use_delta', id: call.id, input: serialized };
        yield { type: 'tool_use_end', id: call.id };
      }
    }

    if (finalVisibleText) {
      content.push({ type: 'text', text: finalVisibleText });
    }

    const sortedSlots = [...toolSlots.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, slot] of sortedSlots) {
      if (!slot.name) continue;
      if (!slot.emittedStart) {
        yield { type: 'tool_use_start', id: slot.id, name: slot.name };
        if (slot.args) yield { type: 'tool_use_delta', id: slot.id, input: slot.args };
      }
      yield { type: 'tool_use_end', id: slot.id };
      content.push({
        type: 'tool_use',
        id: slot.id,
        name: slot.name,
        input: safeParseToolArgsObject(slot.args),
      });
    }
    for (const call of bridgedCalls) {
      content.push(call);
    }

    const hasToolUse = content.some((b) => b.type === 'tool_use');
    const hasVisibleOutput = content.some((b) => (b.type === 'text' && b.text.trim().length > 0) || b.type === 'tool_use');
    if (!started || !hasVisibleOutput) {
      throw new NodeHttpError(502, 'Stream ended without usable content', node.id);
    }

    const stopReason = mapFinishReason(finishReason, hasToolUse);
    if (usage.outputTokens === 0) {
      const approxOut = Math.max(1, Math.ceil((finalVisibleText.length + fullThinking.length) / 4));
      usage = { inputTokens: usage.inputTokens, outputTokens: approxOut, totalTokens: usage.inputTokens + approxOut };
    }

    yield {
      type: 'message_end',
      stopReason,
      usage,
      content,
      model: servedModel,
      providerTermination: { category: stopReason === 'max_tokens' ? 'length' : 'normal' },
      ...(fullThinking ? { reasoningBoundary: { structured: true, literalLeadingText: false } } : {}),
    };
  } finally {
    clearProgressTimer();
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    if (!ctrl.signal.aborted) ctrl.abort();
  }
}

// Exposed for transport-level regression tests without making live model requests.
export { callNodeStream as callZiCommanderNodeStreamForTest };

function parseNonStreamingResponse(
  rawText: string,
  node: AutonomousNode,
  promptBridgeActive: boolean,
  allowedToolNames: Set<string>,
): ParsedNodeTurn {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    const plain = rawText.trim();
    if (!plain || plain.startsWith('<!DOCTYPE') || plain.startsWith('<html')) {
      throw new NodeHttpError(502, `Invalid JSON response: ${plain.slice(0, 140)}`, node.id);
    }
    const extracted = promptBridgeActive
      ? extractPromptToolCalls(plain, allowedToolNames)
      : { cleanText: plain, toolCalls: [] };
    const events: StreamEvent[] = [];
    const content: MessageContent[] = [];
    if (extracted.cleanText) {
      events.push({ type: 'text_delta', text: extracted.cleanText });
      content.push({ type: 'text', text: extracted.cleanText });
    }
    for (const tc of extracted.toolCalls) {
      const s = JSON.stringify(tc.input);
      events.push({ type: 'tool_use_start', id: tc.id, name: tc.name });
      events.push({ type: 'tool_use_delta', id: tc.id, input: s });
      events.push({ type: 'tool_use_end', id: tc.id });
      content.push(tc);
    }
    const approx = Math.max(1, Math.ceil(plain.length / 4));
    return {
      events,
      content,
      stopReason: extracted.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: approx, totalTokens: approx },
      servedModel: node.model,
    };
  }

  if (data.error) {
    const msg = typeof data.error === 'string'
      ? data.error
      : String((data.error as { message?: unknown })?.message || JSON.stringify(data.error));
    throw new NodeHttpError(502, msg, node.id);
  }

  const servedModel = typeof data.model === 'string' && data.model ? data.model : node.model;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const msg = (first?.message ?? first?.delta) as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') {
    throw new NodeHttpError(502, `Missing choices[0].message: ${rawText.slice(0, 180)}`, node.id);
  }

  const events: StreamEvent[] = [];
  const content: MessageContent[] = [];

  const reasoning = typeof msg.reasoning_content === 'string'
    ? msg.reasoning_content
    : typeof msg.reasoning === 'string'
      ? msg.reasoning
      : '';
  if (reasoning) {
    events.push({ type: 'thinking_start' });
    events.push({ type: 'thinking_delta', chars: reasoning.length, text: reasoning });
    events.push({ type: 'thinking_end' });
    content.push({ type: 'thinking', thinking: reasoning, thinkingSignature: 'reasoning_content' });
  }

  let rawContent = '';
  if (typeof msg.content === 'string') {
    rawContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    rawContent = msg.content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('');
  }

  const split = splitLeadingThinkTag(rawContent);
  if (split.thinking && !reasoning) {
    events.push({ type: 'thinking_start' });
    events.push({ type: 'thinking_delta', chars: split.thinking.length, text: split.thinking });
    events.push({ type: 'thinking_end' });
    content.push({ type: 'thinking', thinking: split.thinking, thinkingSignature: 'reasoning_content' });
  }

  const nativeToolCalls: ToolUseContent[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const rec = tc as Record<string, unknown>;
      const fn = rec.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
      if (!name) continue;
      const id = typeof rec.id === 'string' && rec.id ? rec.id : `call_${crypto.randomBytes(8).toString('hex')}`;
      const argsStr = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments || {});
      nativeToolCalls.push({
        type: 'tool_use',
        id,
        name,
        input: safeParseToolArgsObject(argsStr),
      });
    }
  }

  let visibleText = split.visible;
  const bridgedToolCalls: ToolUseContent[] = [];
  if (promptBridgeActive && nativeToolCalls.length === 0 && visibleText) {
    const extracted = extractPromptToolCalls(visibleText, allowedToolNames);
    visibleText = extracted.cleanText;
    bridgedToolCalls.push(...extracted.toolCalls);
  }

  if (visibleText) {
    events.push({ type: 'text_delta', text: visibleText });
    content.push({ type: 'text', text: visibleText });
  }

  const allCalls = [...nativeToolCalls, ...bridgedToolCalls];
  for (const call of allCalls) {
    const s = JSON.stringify(call.input);
    events.push({ type: 'tool_use_start', id: call.id, name: call.name });
    events.push({ type: 'tool_use_delta', id: call.id, input: s });
    events.push({ type: 'tool_use_end', id: call.id });
    content.push(call);
  }

  const usage = normalizeUsage(data.usage as Record<string, unknown> | undefined);
  if (usage.outputTokens === 0 && (visibleText || allCalls.length > 0)) {
    usage.outputTokens = Math.max(1, Math.ceil(visibleText.length / 4));
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  return {
    events,
    content,
    stopReason: mapFinishReason(first?.finish_reason as string | undefined, allCalls.length > 0),
    usage,
    servedModel,
  };
}

function buildOfflineGuidanceMessage(localOnly: boolean): string {
  const lang = String(getCurrentLang?.() || 'ru').toLowerCase();
  const isRu = lang.startsWith('ru');
  if (localOnly) {
    return isRu
      ? [
          '**Режим «Командир · Локальный ПК» активен (100% офлайн, без токенов).**',
          '',
          'Сейчас на компьютере не обнаружен запущенный локальный ИИ-сервер. Запустите любой из них — Командир подхватит модель автоматически без ключей и настроек:',
          '- **Ollama** (`http://127.0.0.1:11434`): установите с `ollama.com` и выполните `ollama run qwen3:8b`',
          '- **LM Studio** (`http://127.0.0.1:1234`): включите Local Server во вкладке Developer',
          '- **llama.cpp / KoboldCpp** (`http://127.0.0.1:8080`) или **Jan** (`http://127.0.0.1:1337`)',
          '',
          'Либо переключите модель на **ZI-Commander · Auto**, чтобы использовать встроенную автономную сеть без ключей.',
        ].join('\n')
      : [
          '**ZI-Commander · Local PC mode is active (100% offline, zero tokens).**',
          '',
          'No running local LLM server was detected on this machine. Start any of the following and Commander will connect automatically without API keys:',
          '- **Ollama** (`http://127.0.0.1:11434`): run `ollama run qwen3:8b`',
          '- **LM Studio** (`http://127.0.0.1:1234`): enable the Local Server',
          '- **llama.cpp** (`http://127.0.0.1:8080`) or **Jan** (`http://127.0.0.1:1337`)',
          '',
          'Or switch to **ZI-Commander · Auto** to use the built-in zero-token mesh.',
        ].join('\n');
  }
  return isRu
    ? [
        '**ZI-Commander не получил ответ от доступных моделей.**',
        '',
        'Проверьте подключение к интернету и повторите запрос. Если ошибка сохраняется, выберите другой настроенный провайдер модели или запустите локальную модель в **Ollama** / **LM Studio**. Сервисам могут требоваться ключи или действовать ограничения доступа.',
      ].join('\n')
    : [
        '**ZI-Commander did not receive a response from available models.**',
        '',
        'Check your connection and retry. If this persists, select another configured model provider or start a local model in **Ollama** / **LM Studio**. Services may require keys or restrict access.',
      ].join('\n');
}

// ── LLMProvider Implementation ────────────────────────────────────────────

export function createZiCommanderProvider(config: { modelId?: string } = {}): LLMProvider {
  const spec = getZiCommanderModelSpec(config.modelId || ZI_COMMANDER_DEFAULT_MODEL);
  let lastServedBudget = {
    key: `${ZI_COMMANDER_PROVIDER}:${spec.id}`,
    model: spec.id,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxTokens,
  };

  async function* runStream(params: CompletionParams): AsyncGenerator<StreamEvent, void, void> {
    const locals = await discoverLocalModels();
    const localNodes = localModelsToNodes(locals);
    const needTools = Array.isArray(params.tools) && params.tools.length > 0;
    const needVision = countImagesInMessages(params.messages) > 0;
    const allowedToolNames = new Set((params.tools || []).map((t) => t.name));

    let candidates = rankCandidates(spec, localNodes, needTools, needVision);
    if (candidates.length === 0 && spec.mode !== 'local') {
      await refreshDynamicKeylessMesh();
      candidates = rankCandidates(spec, localNodes, needTools, needVision);
    }

    if (candidates.length === 0) {
      const text = buildOfflineGuidanceMessage(spec.mode === 'local');
      yield { type: 'message_start', usage: { inputTokens: 0, outputTokens: 32, totalTokens: 32 } };
      yield { type: 'text_delta', text };
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 32, totalTokens: 32 },
        content: [{ type: 'text', text }],
        model: spec.id,
        providerTermination: { category: 'normal' },
      };
      return;
    }

    // Trigger background live-mesh update without blocking the first turn
    if (spec.mode !== 'local' && Date.now() - _dynamicFetchedAt > DYNAMIC_REFRESH_TTL_MS) {
      void refreshDynamicKeylessMesh();
    }

    const maxAttempts = Math.min(candidates.length, 10);
    // In Auto mode, do not spend minutes silently trying unreachable remote nodes.
    // Local models keep their longer cold-start allowance. Once a model starts
    // producing content, only the separate stream-idle watchdog applies.
    let remoteDeadline = 0;
    let lastError: Error | null = null;

    for (let idx = 0; idx < maxAttempts; idx += 1) {
      if (params.signal?.aborted) {
        throw params.signal.reason || new Error('Aborted');
      }
      const node = candidates[idx];
      if (!node.isLocal && spec.mode === 'auto') {
        if (!remoteDeadline) remoteDeadline = Date.now() + 60_000;
        if (Date.now() >= remoteDeadline) break;
      }
      const h = getHealth(node.id);
      const useNativeTools = needTools && node.nativeTools && !h.toolsRejected;
      const useVision = needVision && node.supportsVision && !h.visionRejected;
      const useStream = node.supportsStreaming && !h.streamingRejected;
      const startedAt = Date.now();
      let committedOutput = false;

      const tryOnce = async function* (
        overrideTools: boolean,
        compactContext: boolean,
        streamFlag: boolean,
      ): AsyncGenerator<StreamEvent, void, void> {
        const built = buildOpenAIPayload(params, node, {
          useNativeTools: overrideTools,
          useVision,
          stream: streamFlag,
          compactContext,
        });
        const remainingMs = remoteDeadline && !node.isLocal ? remoteDeadline - Date.now() : Infinity;
        if (remainingMs <= 0) throw new Error('Timeout waiting for an available model');
        const firstByteTimeoutMs = node.isLocal ? 120_000
          : spec.mode === 'auto' ? Math.max(1, Math.min(15_000, remainingMs)) : 28_000;
        for await (const ev of callNodeStream(node, built.payload, {
          signal: params.signal,
          firstByteTimeoutMs,
          idleTimeoutMs: node.isLocal ? 120_000 : 60_000,
          promptBridgeActive: built.promptBridgeActive,
          allowedToolNames,
          omittedImages: built.omittedImages,
        })) {
          if (
            ev.type === 'text_delta'
            || ev.type === 'tool_use_start'
            || ev.type === 'thinking_delta'
          ) {
            committedOutput = true;
          }
          if (ev.type === 'message_end') {
            committedOutput = true;
            recordNodeSuccess(node.id, Date.now() - startedAt);
            lastServedBudget = {
              key: `${ZI_COMMANDER_PROVIDER}:${node.id}`,
              model: spec.id,
              contextWindow: node.contextWindow,
              maxOutputTokens: node.maxOutputTokens,
            };
            yield { ...ev, model: spec.id };
          } else {
            yield ev;
          }
        }
      };

      try {
        for await (const ev of tryOnce(useNativeTools, false, useStream)) {
          yield ev;
        }
        return;
      } catch (err) {
        if (params.signal?.aborted) throw err;
        // If we already emitted partial tokens to the user, don't corrupt the stream by mixing two models
        if (committedOutput) throw err;

        const httpErr = err instanceof NodeHttpError ? err : null;
        const bodyLower = String(httpErr?.body || (err as Error)?.message || '').toLowerCase();

        // Instant same-node recovery when a model dislikes native tools or large context
        if (httpErr && httpErr.status === 400) {
          if (useNativeTools && /tool|function|schema|parameters/.test(bodyLower)) {
            h.toolsRejected = true;
            try {
              for await (const ev of tryOnce(false, false, false)) yield ev;
              return;
            } catch (retryErr) {
              if (params.signal?.aborted || committedOutput) throw retryErr;
            }
          } else if (/context|length|too many tokens|maximum/.test(bodyLower)) {
            try {
              for await (const ev of tryOnce(useNativeTools, true, useStream)) yield ev;
              return;
            } catch (retryErr) {
              if (params.signal?.aborted || committedOutput) throw retryErr;
            }
          }
        }

        recordNodeFailure(node.id, httpErr?.status, httpErr?.body || (err as Error)?.message);
        lastError = err instanceof Error ? err : new Error(String(err));
        log.info('autonomous commander rotating node', {
          failedNode: node.id,
          status: httpErr?.status,
          attempt: idx + 1,
          maxAttempts,
        });

        // If static nodes struggled halfway through, pull fresh live mesh nodes
        if (idx === 4 && spec.mode !== 'local' && _dynamicNodes.length === 0) {
          await refreshDynamicKeylessMesh();
          for (const dyn of _dynamicNodes) {
            if (!candidates.some((c) => c.id === dyn.id)) candidates.push(dyn);
          }
        }
      }
    }

    // Never block the user with an API-key prompt; return actionable status
    log.warn('all autonomous commander nodes exhausted', { error: lastError?.message });
    const fallbackText = buildOfflineGuidanceMessage(spec.mode === 'local');
    yield { type: 'message_start', usage: { inputTokens: 0, outputTokens: 32, totalTokens: 32 } };
    yield { type: 'text_delta', text: fallbackText };
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 32, totalTokens: 32 },
      content: [{ type: 'text', text: fallbackText }],
      model: spec.id,
      providerTermination: { category: 'normal' },
    };
  }

  return {
    id: ZI_COMMANDER_PROVIDER,
    name: spec.label,
    contextBudgetModel: () => spec.id,
    contextBudget: () => lastServedBudget,
    async validateAuth(): Promise<boolean> {
      return true;
    },
    stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      return runStream(params);
    },
    async complete(params: CompletionParams): Promise<CompletionResult> {
      let content: MessageContent[] = [];
      let stopReason: StopReason = 'end_turn';
      let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let model = spec.id;
      for await (const ev of runStream(params)) {
        if (ev.type === 'message_end') {
          if (ev.content) content = ev.content;
          stopReason = ev.stopReason;
          if (ev.usage) {
            usage = {
              inputTokens: ev.usage.inputTokens ?? 0,
              outputTokens: ev.usage.outputTokens ?? 0,
              totalTokens: ev.usage.totalTokens ?? ((ev.usage.inputTokens ?? 0) + (ev.usage.outputTokens ?? 0)),
            };
          }
          if (ev.model) model = ev.model;
        } else if (ev.type === 'error') {
          throw ev.error;
        }
      }
      return { content, stopReason, usage, model };
    },
  };
}

// ── Status & Diagnostics for Settings UI ──────────────────────────────────

export interface AutonomousCommanderStatus {
  ok: true;
  active: true;
  provider: typeof ZI_COMMANDER_PROVIDER;
  defaultModel: string;
  models: readonly ZiCommanderModelSpec[];
  localModels: DiscoveredLocalModel[];
  meshNodeCount: number;
  activeNodeLabel: string | null;
}

export async function getAutonomousCommanderStatus(opts?: {
  rescanLocal?: boolean;
}): Promise<AutonomousCommanderStatus> {
  const localModels = await discoverLocalModels({
    force: opts?.rescanLocal === true,
    timeoutMs: opts?.rescanLocal ? 1_200 : 450,
  });
  const allNodes = [
    ...localModelsToNodes(localModels),
    ...STATIC_KEYLESS_NODES,
    ..._dynamicNodes,
  ];
  let bestNode: { label: string; at: number } | null = null;
  for (const node of allNodes) {
    const h = _nodeHealth.get(node.id);
    if (h && h.lastOkAt > 0 && h.cooldownUntil <= Date.now()) {
      if (!bestNode || h.lastOkAt > bestNode.at) {
        bestNode = { label: node.label, at: h.lastOkAt };
      }
    }
  }
  return {
    ok: true,
    active: true,
    provider: ZI_COMMANDER_PROVIDER,
    defaultModel: ZI_COMMANDER_DEFAULT_MODEL,
    models: ZI_COMMANDER_MODELS,
    localModels,
    meshNodeCount: STATIC_KEYLESS_NODES.length + _dynamicNodes.length,
    activeNodeLabel: bestNode?.label || (localModels[0] ? `${localModels[0].runtime} · ${localModels[0].model}` : null),
  };
}

export async function testAutonomousCommander(modelId?: string): Promise<{
  ok: boolean;
  latencyMs: number;
  activeNodeLabel?: string;
  reply?: string;
  error?: string;
}> {
  const startedAt = Date.now();
  try {
    const provider = createZiCommanderProvider({ modelId: modelId || ZI_COMMANDER_DEFAULT_MODEL });
    const res = await provider.complete({
      model: modelId || ZI_COMMANDER_DEFAULT_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with: OK' }] }],
      maxTokens: 32,
      temperature: 0,
    });
    const text = res.content
      .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    const status = await getAutonomousCommanderStatus();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      activeNodeLabel: status.activeNodeLabel || undefined,
      reply: text.slice(0, 120),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: (err as Error)?.message || String(err),
    };
  }
}
