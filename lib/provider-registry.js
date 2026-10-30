const PLATFORM_NAMES = ["TikTok", "Kwai", "Instagram", "Facebook", "YouTube"];

/**
 * Enable a provider only after a documented, authorized integration exists.
 * A third-party downloader alone is not sufficient authorization.
 */
const providers = PLATFORM_NAMES.map(platform => ({
  id: platform.toLowerCase(),
  platform,
  status: "planned",
  enabled: false,
  supportedOperations: [],
  reason: "Integração oficial ou contratualmente autorizada ainda não configurada."
}));

export function listProviders() {
  return providers.map(provider => ({
    ...provider,
    supportedOperations: [...provider.supportedOperations]
  }));
}

export function getProvider(platform) {
  const provider = providers.find(item => item.platform === platform);
  return provider ? {
    ...provider,
    supportedOperations: [...provider.supportedOperations]
  } : null;
}
