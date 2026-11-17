import { isDeepSeekModelConfigEnabled } from '../features/client_config';

/**
 * DeepSeek availability is controlled by Server client config
 * `model.deepseek.enabled`. The desktop default is enabled so offline and
 * Open-source runs keep the provider available until Server says otherwise.
 */
export function isDeepSeekIntegrationEnabled(): boolean {
  return isDeepSeekModelConfigEnabled();
}

export function isDeepSeekProviderId(providerId: string): boolean {
  return String(providerId || '').trim().toLowerCase() === 'deepseek';
}

export function isDeepSeekModelId(modelId: string): boolean {
  return /deepseek/i.test(String(modelId || ''));
}

export function isOrkasHostedProviderId(providerId: string): boolean {
  return String(providerId || '').trim().toLowerCase() === 'orkas-api';
}

export function isModelProviderAllowed(providerId: string, modelId?: string): boolean {
  if (isOrkasHostedProviderId(providerId)) return false;
  if (isDeepSeekIntegrationEnabled()) return true;
  if (isDeepSeekProviderId(providerId)) return false;
  if (modelId && isDeepSeekModelId(modelId)) return false;
  return true;
}

export function assertModelProviderAllowed(providerId: string, modelId?: string): void {
  if (isOrkasHostedProviderId(providerId)) {
    throw new Error('Hosted Orkas API is disabled in autonomous ZI-Orkas');
  }
  if (!isModelProviderAllowed(providerId, modelId)) {
    throw new Error('Provider is disabled in this build');
  }
}
