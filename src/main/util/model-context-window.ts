/** Minimum context window for ZI-Orkas chat models; 4K allows compact local
 * Ollama / llama.cpp models to run natively alongside large models. */
export const MIN_NATIVE_MODEL_CONTEXT_WINDOW = 4_096;

export function modelContextWindowBelowMinimum(window: number | undefined): boolean {
  return typeof window === 'number' && Number.isFinite(window)
    && window < MIN_NATIVE_MODEL_CONTEXT_WINDOW;
}
