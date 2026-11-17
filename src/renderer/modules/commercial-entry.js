(function () {
  const isFailure = value => value?.ok === false && value?.code === 'E_COMMERCIAL_REQUIRED' && value?.feature === 'web_apps';
  async function download() {
    try {
      const info = await window.orkas.invoke('ziOrkas.info', {});
      const url = info?.releasesUrl || 'https://github.com/zigorminsk-debug/ZI-orkas/releases';
      await window.orkas.invoke('auth.openExternal', { url });
    } catch (_) {}
  }
  function show(appId) {
    if (window.ZIOrkasSuite && typeof window.ZIOrkasSuite.openAppPublishDialog === 'function') {
      return window.ZIOrkasSuite.openAppPublishDialog(appId);
    }
    return download();
  }
  window.OrkasCommercialEntry = { show, download, isFailure };
})();
