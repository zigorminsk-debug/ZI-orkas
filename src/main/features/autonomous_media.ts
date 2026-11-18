/**
 * ZI-Orkas Autonomous Media & Search Runtime
 *
 * Provides zero-token, self-contained implementations for:
 *   - Web Search (`zi-search`): DuckDuckGo + Wikipedia RU/EN keyless search
 *   - Image Generation (`zi-image`): Local SD WebUI → Pollinations FLUX → AI Horde → Offline Sharp PNG
 *   - Video Generation (`zi-video`): Multi-keyframe AI + bundled FFmpeg H.264 HD cinema renderer
 *   - Speech Synthesis (`zi-tts`): Keyless Neural TTS (RU/EN/multilingual) + Offline OS TTS + FFmpeg
 *   - Voice Input STT: 100% offline local Whisper (`whisper-cli` + `ggml-base-q5_1.bin`)
 *
 * Never contacts `orkas.ai` and never requires any API keys, tokens, or credits.
 */

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logger';
import { bundledFfmpegPaths, bundledRuntimeEnv, bundledWhisperPaths } from '../util/bundled-runtime';

const execFileAsync = promisify(execFile);
const log = createLogger('zi-autonomous-media');

export const ZI_SEARCH_PROVIDER = 'zi-search';
export const ZI_IMAGE_PROVIDER = 'zi-image';
export const ZI_IMAGE_MODEL = 'zi-flux';
export const ZI_VIDEO_PROVIDER = 'zi-video';
export const ZI_VIDEO_MODEL = 'zi-cinema-hd';
export const ZI_TTS_PROVIDER = 'zi-tts';
export const ZI_TTS_MODEL = 'zi-neural-tts';
export const ZI_TTS_DEFAULT_VOICE = 'auto';
export const ZI_KEYLESS_SENTINEL = 'zi-autonomous';

function resolveFfmpegBin(): string {
  return bundledFfmpegPaths().ffmpeg || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function escapeXml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeHtmlEntities(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguageCode(text: string, hint?: string): string {
  const h = String(hint || '').trim().toLowerCase();
  if (h && h !== 'auto' && h !== 'default' && /^[a-z]{2}(?:-[a-z]{2})?$/.test(h)) {
    return h.slice(0, 2);
  }
  if (/[а-яёіїєґ]/i.test(text)) return 'ru';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[äöüß]/i.test(text)) return 'de';
  if (/[éèêëàâçùûîïôœ]/i.test(text)) return 'fr';
  if (/[ñ¿¡]/i.test(text)) return 'es';
  return 'en';
}

// ── 1. Autonomous Web Search (DuckDuckGo + Wikipedia, zero key) ───────────

export interface AutonomousSearchHit {
  title: string;
  url: string;
  snippet: string;
}

function unwrapDdgRedirect(rawHref: string): string {
  const href = rawHref.replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(href) && !href.includes('duckduckgo.com/l/')) return href;
  try {
    const full = href.startsWith('//') ? `https:${href}` : href.startsWith('/') ? `https://duckduckgo.com${href}` : href;
    const u = new URL(full);
    const uddg = u.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
  } catch { /* ignore */ }
  return '';
}

async function searchDuckDuckGoHtml(query: string, count: number, signal?: AbortSignal): Promise<AutonomousSearchHit[]> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason || new Error('Aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), 14_000);
  try {
    const body = new URLSearchParams({ q: query, kl: /[а-яё]/i.test(query) ? 'ru-ru' : 'wt-wt' });
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const hits: AutonomousSearchHit[] = [];
    const seen = new Set<string>();
    const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) !== null && hits.length < count) {
      const url = unwrapDdgRedirect(m[1]);
      if (!url || seen.has(url) || url.includes('duckduckgo.com/y.js')) continue;
      const title = decodeHtmlEntities(m[2]);
      const snippet = decodeHtmlEntities(m[3] || m[4] || '');
      if (!title) continue;
      seen.add(url);
      hits.push({ title, url, snippet });
    }
    return hits;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function searchWikipedia(query: string, count: number, signal?: AbortSignal): Promise<AutonomousSearchHit[]> {
  const lang = /[а-яё]/i.test(query) ? 'ru' : 'en';
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason || new Error('Aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    u.searchParams.set('action', 'query');
    u.searchParams.set('list', 'search');
    u.searchParams.set('srsearch', query);
    u.searchParams.set('srlimit', String(Math.min(10, Math.max(3, count))));
    u.searchParams.set('format', 'json');
    const res = await fetch(u.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ZI-Orkas/1.0 (Personal Autonomous Desktop)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
    };
    const list = data?.query?.search || [];
    return list.slice(0, count).map((item) => {
      const title = String(item.title || '').trim();
      return {
        title: `${title} — Wikipedia`,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        snippet: decodeHtmlEntities(item.snippet || ''),
      };
    }).filter((h) => !!h.title);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function autonomousWebSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<AutonomousSearchHit[]> {
  const limit = Math.max(1, Math.min(20, count || 8));
  const ddg = await searchDuckDuckGoHtml(query, limit, signal);
  if (ddg.length >= Math.min(3, limit)) return ddg.slice(0, limit);
  const wiki = await searchWikipedia(query, limit, signal);
  const seen = new Set(ddg.map((h) => h.url));
  const merged = [...ddg];
  for (const w of wiki) {
    if (!seen.has(w.url)) {
      seen.add(w.url);
      merged.push(w);
    }
    if (merged.length >= limit) break;
  }
  return merged;
}

// ── 2. Autonomous Image Generation (Local SD → Pollinations FLUX → AI Horde → Sharp) ──

export function parsePixelDimensions(sizeOrRatio?: string): { width: number; height: number } {
  const raw = String(sizeOrRatio || '').trim().toLowerCase();
  const exact = /^(\d{2,4})x(\d{2,4})$/.exec(raw);
  if (exact) {
    const w = Math.max(256, Math.min(1536, Math.round(Number(exact[1]) / 8) * 8));
    const h = Math.max(256, Math.min(1536, Math.round(Number(exact[2]) / 8) * 8));
    return { width: w, height: h };
  }
  if (raw === '16:9' || raw.includes('landscape')) return { width: 1280, height: 720 };
  if (raw === '9:16' || raw.includes('portrait')) return { width: 720, height: 1280 };
  if (raw === '4:3') return { width: 1024, height: 768 };
  if (raw === '3:4') return { width: 768, height: 1024 };
  if (raw === '21:9') return { width: 1344, height: 576 };
  return { width: 1024, height: 1024 };
}

function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

async function tryLocalStableDiffusion(
  prompt: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  const base = String(process.env.ZI_LOCAL_SD_URL || 'http://127.0.0.1:7860').replace(/\/+$/, '');
  const probeCtrl = new AbortController();
  const probeTimer = setTimeout(() => probeCtrl.abort(), 450);
  try {
    const ping = await fetch(`${base}/sdapi/v1/options`, { signal: probeCtrl.signal });
    if (!ping.ok) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(probeTimer);
  }
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, height, steps: 22, cfg_scale: 7 }),
      signal,
    });
    if (!res.ok) return null;
    const json = await res.json() as { images?: string[] };
    const b64 = json?.images?.[0];
    if (!b64) return null;
    const bytes = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const mimeType = detectImageMime(bytes);
    return mimeType ? { bytes, mimeType } : null;
  } catch {
    return null;
  }
}

async function tryPollinationsImage(
  prompt: string,
  width: number,
  height: number,
  seed: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  const cleanPrompt = prompt.replace(/\s+/g, ' ').trim().slice(0, 900);
  const encoded = encodeURIComponent(cleanPrompt);
  const w = Math.min(1280, width);
  const h = Math.min(1280, height);
  const urls = [
    `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&seed=${seed}&model=flux&nologo=true`,
    `https://pollinations.ai/p/${encoded}?width=${w}&height=${h}&seed=${seed}&nologo=true`,
  ];
  for (const url of urls) {
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 55_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'image/*' },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const bytes = Buffer.from(arr);
      const mimeType = detectImageMime(bytes);
      if (mimeType && bytes.length > 2048) {
        return { bytes, mimeType };
      }
    } catch {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return null;
}

async function tryAiHordeImage(
  prompt: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  // AI Horde accepts sizes in multiples of 64; 512..768 stay in the free anonymous tier
  const w = Math.max(512, Math.min(768, Math.round(width / 64) * 64));
  const h = Math.max(512, Math.min(768, Math.round(height / 64) * 64));
  try {
    const submitRes = await fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: '0000000000',
        'Client-Agent': 'ZI-Orkas:1.0:local',
      },
      body: JSON.stringify({
        prompt: prompt.slice(0, 900),
        params: { width: w, height: h, steps: 20, n: 1 },
        nsfw: false,
        r2: true,
      }),
      signal,
    });
    if (!submitRes.ok) return null;
    const submitJson = await submitRes.json() as { id?: string };
    const id = String(submitJson?.id || '').trim();
    if (!id) return null;

    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      await new Promise((r) => setTimeout(r, 3_500));
      const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${encodeURIComponent(id)}`, {
        headers: { 'Client-Agent': 'ZI-Orkas:1.0:local' },
        signal,
      });
      if (!statusRes.ok) continue;
      const status = await statusRes.json() as {
        done?: boolean;
        faulted?: boolean;
        generations?: Array<{ img?: string }>;
      };
      if (status.faulted) return null;
      if (!status.done) continue;
      const img = status.generations?.[0]?.img;
      if (!img) return null;
      let bytes: Buffer;
      if (/^https?:\/\//i.test(img)) {
        const dl = await fetch(img, { signal });
        if (!dl.ok) return null;
        bytes = Buffer.from(await dl.arrayBuffer());
      } else {
        bytes = Buffer.from(img, 'base64');
      }
      const mimeType = detectImageMime(bytes);
      return mimeType ? { bytes, mimeType } : null;
    }
    return null;
  } catch {
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    return null;
  }
}

async function renderOfflineArtworkPng(
  prompt: string,
  width: number,
  height: number,
  seed: number,
): Promise<{ bytes: Buffer; mimeType: 'image/png' }> {
  const sharpMod = (await import('sharp')).default;
  const palettes = [
    ['#0f172a', '#1e3a8a', '#38bdf8', '#a78bfa'],
    ['#111827', '#065f46', '#10b981', '#34d399'],
    ['#1f1135', '#6d28d9', '#ec4899', '#fbbf24'],
    ['#0c1222', '#1d4ed8', '#06b6d4', '#f472b6'],
  ];
  const pal = palettes[Math.abs(seed) % palettes.length];
  const cleanTitle = prompt.replace(/\s+/g, ' ').trim().slice(0, 120);
  const words = cleanTitle.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 34) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= 3) break;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur && lines.length < 4) lines.push(cur);
  const cx1 = Math.round(width * (0.25 + ((seed % 37) / 100)));
  const cy1 = Math.round(height * (0.3 + ((seed % 29) / 100)));
  const cx2 = Math.round(width * (0.72 - ((seed % 23) / 100)));
  const cy2 = Math.round(height * (0.68 - ((seed % 31) / 100)));
  const r1 = Math.round(Math.min(width, height) * 0.42);
  const r2 = Math.round(Math.min(width, height) * 0.34);
  const fontSize = Math.max(22, Math.round(Math.min(width, height) * 0.038));
  const startY = Math.round(height * 0.5 - ((lines.length - 1) * fontSize * 0.7));
  const textEls = lines
    .map((ln, idx) => `<text x="50%" y="${startY + idx * Math.round(fontSize * 1.4)}" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-weight="600" font-size="${fontSize}" opacity="0.95">${escapeXml(ln)}</text>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${pal[0]}"/>
      <stop offset="55%" stop-color="${pal[1]}"/>
      <stop offset="100%" stop-color="${pal[0]}"/>
    </linearGradient>
    <radialGradient id="g1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${pal[2]}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${pal[2]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${pal[3]}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${pal[3]}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${cx1}" cy="${cy1}" r="${r1}" fill="url(#g1)"/>
  <circle cx="${cx2}" cy="${cy2}" r="${r2}" fill="url(#g2)"/>
  ${textEls}
</svg>`;
  const bytes = await sharpMod(Buffer.from(svg)).png().toBuffer();
  return { bytes, mimeType: 'image/png' };
}

export async function autonomousGenerateImage(params: {
  prompt: string;
  size?: string;
  seed?: number;
  signal?: AbortSignal;
}): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }> {
  const { width, height } = parsePixelDimensions(params.size);
  const seed = typeof params.seed === 'number' && Number.isFinite(params.seed)
    ? Math.abs(Math.trunc(params.seed))
    : crypto.randomInt(1, 2_000_000_000);

  const local = await tryLocalStableDiffusion(params.prompt, width, height, params.signal);
  if (local) return local;

  const pollinations = await tryPollinationsImage(params.prompt, width, height, seed, params.signal);
  if (pollinations) return pollinations;

  const horde = await tryAiHordeImage(params.prompt, width, height, params.signal);
  if (horde) return horde;

  log.warn('online keyless image providers unreachable, rendering local artwork PNG');
  return renderOfflineArtworkPng(params.prompt, width, height, seed);
}

// ── 3. Autonomous Video Generation (AI Keyframes + Bundled FFmpeg Cinema MP4) ──

export async function autonomousGenerateVideo(params: {
  prompt: string;
  ratio?: string;
  resolution?: string;
  durationSec?: number;
  seed?: number;
  referenceImagePaths?: string[];
  signal?: AbortSignal;
  onProgress?: (phase: string, message: string) => void;
}): Promise<{ buffer: Buffer; mimeType: 'video/mp4' }> {
  const ratio = String(params.ratio || '16:9').trim();
  const hiRes = params.resolution === '1080p' || params.resolution === '4k';
  let width = hiRes ? 1920 : 1280;
  let height = hiRes ? 1080 : 720;
  if (ratio === '9:16') { width = hiRes ? 1080 : 720; height = hiRes ? 1920 : 1280; }
  else if (ratio === '1:1') { width = 1024; height = 1024; }
  else if (ratio === '4:3') { width = 1280; height = 960; }
  else if (ratio === '3:4') { width = 960; height = 1280; }
  else if (ratio === '21:9') { width = 1280; height = 548; }
  width = Math.floor(width / 2) * 2;
  height = Math.floor(height / 2) * 2;

  const duration = Math.max(3, Math.min(20, Math.round(Number(params.durationSec) || 6)));
  const baseSeed = typeof params.seed === 'number' && Number.isFinite(params.seed)
    ? Math.abs(Math.trunc(params.seed))
    : crypto.randomInt(1, 1_000_000_000);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zi-video-'));
  try {
    const frameFiles: string[] = [];
    const existingRefs = (params.referenceImagePaths || []).filter((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    });

    for (let i = 0; i < Math.min(2, existingRefs.length); i += 1) {
      const dest = path.join(tmpDir, `scene-${i}.png`);
      const sharpMod = (await import('sharp')).default;
      await sharpMod(existingRefs[i]).resize(width, height, { fit: 'cover' }).png().toFile(dest);
      frameFiles.push(dest);
    }

    const desiredScenes = duration >= 7 ? 2 : 1;
    const sharpMod = (await import('sharp')).default;
    while (frameFiles.length < desiredScenes) {
      const idx = frameFiles.length;
      params.onProgress?.('generating', `Rendering AI scene ${idx + 1}/${desiredScenes}`);
      const scenePrompt = idx === 0
        ? `${params.prompt}, cinematic lighting, ultra detailed, film still`
        : `${params.prompt}, dynamic angle continuation, cinematic depth of field, film still`;
      const img = await autonomousGenerateImage({
        prompt: scenePrompt,
        size: `${Math.min(1280, width)}x${Math.min(1280, height)}`,
        seed: baseSeed + idx * 101,
        signal: params.signal,
      });
      const dest = path.join(tmpDir, `scene-${idx}.png`);
      await sharpMod(img.bytes).resize(width, height, { fit: 'cover' }).png().toFile(dest);
      frameFiles.push(dest);
    }

    params.onProgress?.('encoding', 'Encoding HD H.264 video via local FFmpeg');
    const outMp4 = path.join(tmpDir, 'output.mp4');
    const ffmpeg = resolveFfmpegBin();
    const fps = 25;

    let ffArgs: string[];
    if (frameFiles.length === 1) {
      const totalFrames = duration * fps;
      const vf = `scale=${width * 2}:${height * 2},zoompan=z='min(zoom+0.0012,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},format=yuv420p`;
      ffArgs = [
        '-y',
        '-loop', '1',
        '-i', frameFiles[0],
        '-vf', vf,
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '21',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        outMp4,
      ];
    } else {
      const fadeSec = 0.8;
      const segDur = (duration + fadeSec) / 2;
      const segFrames = Math.ceil(segDur * fps);
      const offset = Math.max(1, Number((segDur - fadeSec).toFixed(2)));
      const filterComplex = [
        `[0:v]scale=${width * 2}:${height * 2},zoompan=z='min(zoom+0.0013,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${width}x${height}:fps=${fps},settb=AVTB[v0]`,
        `[1:v]scale=${width * 2}:${height * 2},zoompan=z='if(lte(zoom,1.0),1.15,max(1.001,zoom-0.0013))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${segFrames}:s=${width}x${height}:fps=${fps},settb=AVTB[v1]`,
        `[v0][v1]xfade=transition=fade:duration=${fadeSec}:offset=${offset},format=yuv420p[outv]`,
      ].join(';');
      ffArgs = [
        '-y',
        '-loop', '1', '-t', String(segDur), '-i', frameFiles[0],
        '-loop', '1', '-t', String(segDur), '-i', frameFiles[1],
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '21',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        outMp4,
      ];
    }

    await execFileAsync(ffmpeg, ffArgs, {
      env: bundledRuntimeEnv(),
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });

    const buffer = await fsp.readFile(outMp4);
    return { buffer, mimeType: 'video/mp4' };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 4. Autonomous Speech Synthesis TTS (Keyless Web TTS + Offline OS TTS + FFmpeg) ──

function splitTextForTts(text: string, maxChars = 185): string[] {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?…;:\n])\s+/);
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (!s) continue;
    if ((cur ? `${cur} ${s}` : s).length <= maxChars) {
      cur = cur ? `${cur} ${s}` : s;
      continue;
    }
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
    if (s.length <= maxChars) {
      cur = s;
    } else {
      const words = s.split(' ');
      for (const w of words) {
        if ((cur ? `${cur} ${w}` : w).length <= maxChars) {
          cur = cur ? `${cur} ${w}` : w;
        } else {
          if (cur) chunks.push(cur);
          cur = w.slice(0, maxChars);
        }
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function synthesizeViaKeylessHttpMp3(
  text: string,
  lang: string,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const chunks = splitTextForTts(text, 185);
  if (chunks.length === 0) return null;
  const partPaths: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    const q = encodeURIComponent(chunks[i]);
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${q}`;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'audio/mpeg,*/*',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 256) return null;
      const p = path.join(tmpDir, `part-${String(i).padStart(4, '0')}.mp3`);
      await fsp.writeFile(p, buf);
      partPaths.push(p);
    } catch {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      return null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  if (partPaths.length === 1) return partPaths[0];
  const listFile = path.join(tmpDir, 'concat.txt');
  const concatLines = partPaths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listFile, concatLines, 'utf8');
  const merged = path.join(tmpDir, 'merged.mp3');
  await execFileAsync(resolveFfmpegBin(), [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '3', merged,
  ], { env: bundledRuntimeEnv(), timeout: 60_000, windowsHide: true });
  return merged;
}

async function synthesizeViaSystemOfflineWav(
  text: string,
  lang: string,
  tmpDir: string,
  speed = 1,
): Promise<string | null> {
  const textFile = path.join(tmpDir, 'input.txt');
  const wavFile = path.join(tmpDir, 'system.wav');
  await fsp.writeFile(textFile, text, 'utf8');

  try {
    if (process.platform === 'win32') {
      const rate = Math.max(-6, Math.min(6, Math.round((speed - 1) * 5)));
      const psScript = [
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        `$s.Rate = ${rate};`,
        `$txt = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8);`,
        `$s.SetOutputToWaveFile('${wavFile.replace(/'/g, "''")}');`,
        '$s.Speak($txt);',
        '$s.Dispose();',
      ].join(' ');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        timeout: 60_000,
        windowsHide: true,
      });
      if (fs.existsSync(wavFile) && fs.statSync(wavFile).size > 256) return wavFile;
    } else if (process.platform === 'darwin') {
      const aiffFile = path.join(tmpDir, 'system.aiff');
      const wpm = Math.max(110, Math.min(320, Math.round(180 * speed)));
      await execFileAsync('/usr/bin/say', ['-r', String(wpm), '-f', textFile, '-o', aiffFile], {
        timeout: 60_000,
      });
      if (fs.existsSync(aiffFile) && fs.statSync(aiffFile).size > 256) return aiffFile;
    } else {
      const wpm = Math.max(100, Math.min(320, Math.round(165 * speed)));
      for (const bin of ['espeak-ng', 'espeak']) {
        try {
          await execFileAsync(bin, ['-v', lang, '-s', String(wpm), '-f', textFile, '-w', wavFile], {
            timeout: 60_000,
          });
          if (fs.existsSync(wavFile) && fs.statSync(wavFile).size > 256) return wavFile;
        } catch { /* try next */ }
      }
    }
  } catch (err) {
    log.warn('offline OS TTS failed', { error: (err as Error)?.message });
  }
  return null;
}

export async function autonomousGenerateSpeech(params: {
  text: string;
  voice?: string;
  format?: string;
  speed?: number;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<{ format: string; bytes: number }> {
  const fmt = ['mp3', 'wav', 'opus', 'aac', 'flac', 'ogg'].includes(String(params.format || '').toLowerCase())
    ? String(params.format).toLowerCase()
    : 'mp3';
  const speed = typeof params.speed === 'number' && Number.isFinite(params.speed)
    ? Math.max(0.5, Math.min(2.0, params.speed))
    : 1.0;
  const lang = detectLanguageCode(params.text, params.voice);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zi-tts-'));
  try {
    let sourceAudio = await synthesizeViaKeylessHttpMp3(params.text, lang, tmpDir, params.signal);
    if (!sourceAudio) {
      sourceAudio = await synthesizeViaSystemOfflineWav(params.text, lang, tmpDir, speed);
    }
    if (!sourceAudio) {
      throw new Error('Speech synthesis failed: neither keyless neural TTS nor offline system voice succeeded.');
    }

    await fsp.mkdir(path.dirname(params.outputPath), { recursive: true });
    const needsTranscode = path.extname(sourceAudio).slice(1).toLowerCase() !== fmt || Math.abs(speed - 1.0) > 0.04;

    if (!needsTranscode) {
      await fsp.copyFile(sourceAudio, params.outputPath);
    } else {
      const af = Math.abs(speed - 1.0) > 0.04 ? ['-filter:a', `atempo=${speed.toFixed(2)}`] : [];
      await execFileAsync(resolveFfmpegBin(), [
        '-y', '-i', sourceAudio, ...af, params.outputPath,
      ], { env: bundledRuntimeEnv(), timeout: 60_000, windowsHide: true });
    }
    const stat = await fsp.stat(params.outputPath);
    return { format: fmt, bytes: stat.size };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 5. Autonomous Local Offline Speech-to-Text (Bundled Whisper CLI) ──────

function buildPcm16MonoWav(pcm16: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);         // Audio format = 1 (PCM)
  header.writeUInt16LE(1, 22);         // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);         // Block align
  header.writeUInt16LE(16, 34);        // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

export function isLocalWhisperAvailable(): boolean {
  const w = bundledWhisperPaths();
  return !!(w.cli && w.model && fs.existsSync(w.cli) && fs.existsSync(w.model));
}

export async function autonomousTranscribePcm(params: {
  pcm16: Buffer;
  sampleRate?: number;
  language?: string;
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const whisper = bundledWhisperPaths();
  if (!whisper.cli || !whisper.model || !fs.existsSync(whisper.cli) || !fs.existsSync(whisper.model)) {
    return { ok: false, text: '', error: 'E_WHISPER_NOT_AVAILABLE' };
  }
  if (!params.pcm16 || params.pcm16.length < 1600) {
    return { ok: true, text: '' };
  }
  const rate = typeof params.sampleRate === 'number' && params.sampleRate >= 8000 && params.sampleRate <= 96000
    ? Math.trunc(params.sampleRate)
    : 16_000;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zi-stt-'));
  try {
    let wavPath = path.join(tmpDir, 'input.wav');
    await fsp.writeFile(wavPath, buildPcm16MonoWav(params.pcm16, rate));
    if (rate !== 16_000) {
      const resampled = path.join(tmpDir, 'input-16k.wav');
      await execFileAsync(resolveFfmpegBin(), [
        '-y', '-i', wavPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', resampled,
      ], { env: bundledRuntimeEnv(), timeout: 30_000, windowsHide: true });
      wavPath = resampled;
    }

    const outPrefix = path.join(tmpDir, 'transcript');
    const threads = String(Math.max(1, Math.min(8, os.cpus().length || 4)));
    const langArg = params.language && /^[a-z]{2}$/i.test(params.language)
      ? params.language.toLowerCase()
      : 'auto';

    const { stdout } = await execFileAsync(whisper.cli, [
      '-m', whisper.model,
      '-f', wavPath,
      '-l', langArg,
      '-t', threads,
      '-nt',
      '-np',
      '-otxt',
      '-of', outPrefix,
    ], {
      env: bundledRuntimeEnv(),
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });

    const txtPath = `${outPrefix}.txt`;
    const raw = fs.existsSync(txtPath)
      ? await fsp.readFile(txtPath, 'utf8')
      : String(stdout || '');
    const cleaned = raw
      .replace(/\[(?:BLANK_AUDIO|MUSIC|SILENCE|NOISE|ТИШИНА|МУЗЫКА)[^\]]*\]/gi, '')
      .replace(/\((?:silence|music|noise|blank audio)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, text: cleaned };
  } catch (err) {
    log.warn('local whisper transcription failed', { error: (err as Error)?.message });
    return { ok: false, text: '', error: (err as Error)?.message || 'E_WHISPER_FAILED' };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
