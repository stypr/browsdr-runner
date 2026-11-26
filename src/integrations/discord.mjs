const WEBHOOK_TIMEOUT_MS = 5000;

export function makeDiscordNotifier(configuredUrl, { signal, log }) {
  if (!configuredUrl?.trim()) return;
  const url = URL.parse(configuredUrl.trim());
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    log('BROWSDR_DISCORD_WEBHOOK_URL must be an HTTPS webhook URL.');
    return;
  }
  url.searchParams.set('wait', 'true');
  let started = false;

  return async (link, deviceName) => {
    if (started || signal.aborted) return;
    started = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `BrowSDR online (${deviceName})\n<${link.href}>`,
          allowed_mentions: { parse: [] },
        }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) log('Discord startup notification sent.');
      else log(`Discord startup notification failed (HTTP ${response.status}).`);
    } catch {
      // The token is part of the URL. Keep URLs and transport error details out of logs.
      if (!signal.aborted) log('Discord startup notification failed (network error or timeout).');
    }
  };
}
