/**
 * Local Offline Voice Input (Whisper STT).
 *
 * Replaces hosted Orkas cloud WebSocket ASR with 100% local, zero-token,
 * unlimited-duration transcription via bundled `whisper-cli` + `ggml-base-q5_1.bin`.
 */
import { systemPreferences } from 'electron';
import { autonomousTranscribePcm, isLocalWhisperAvailable } from './autonomous_media';

export function getVoiceStatus(): { configured: boolean; localWhisper: boolean } {
  const ready = isLocalWhisperAvailable();
  return { configured: true, localWhisper: ready };
}

export async function createVoiceSession(): Promise<{
  ok: boolean;
  code?: string;
  mode?: 'local-whisper';
  maxSeconds?: number;
}> {
  if (!isLocalWhisperAvailable()) {
    return { ok: false, code: 'unavailable' };
  }
  // Unlimited local recording (up to 30 minutes per clip) — zero cloud limits.
  return { ok: true, mode: 'local-whisper', maxSeconds: 1800 };
}

export async function transcribeVoicePcm(input: {
  pcmBase64?: string;
  sampleRate?: number;
  language?: string;
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const b64 = String(input?.pcmBase64 || '').trim();
  if (!b64) return { ok: true, text: '' };
  const pcm16 = Buffer.from(b64, 'base64');
  return autonomousTranscribePcm({
    pcm16,
    sampleRate: input?.sampleRate,
    language: input?.language,
  });
}

export async function ensureMicrophoneAccess(
  platform: NodeJS.Platform = process.platform,
): Promise<{ granted: boolean; status: string }> {
  if (platform !== 'darwin') return { granted: true, status: 'unknown' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { granted: true, status };
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted, status: granted ? 'granted' : systemPreferences.getMediaAccessStatus('microphone') };
  }
  return { granted: false, status };
}
