import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDiscordNotifier } from '../src/integrations/discord.mjs';

const webhook = 'https://discord.example/api/webhooks/123/test-token?thread_id=456';
const link = new URL('https://sdr.example/?connect=abcde');

test('Discord receives the connect link once per runner, even with overlapping announcements', async (t) => {
  const called = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const logs = [];
  const notify = makeDiscordNotifier(webhook, { signal: new AbortController().signal, log: (line) => logs.push(line) });

  await Promise.all([notify(link, 'RTL-SDR'), notify(link, 'RTL-SDR')]);
  await notify(link, 'RTL-SDR');

  assert.equal(called.mock.callCount(), 1);
  const [url, options] = called.mock.calls[0].arguments;
  assert.equal(url.href, `${webhook}&wait=true`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), {
    content: 'BrowSDR online (RTL-SDR)\n<https://sdr.example/?connect=abcde>',
    allowed_mentions: { parse: [] },
  });
  assert.deepEqual(logs, ['Discord startup notification sent.']);
});

test('Discord failures are reported without logging the webhook token', async (t) => {
  const called = t.mock.method(globalThis, 'fetch', async () => new Response('test-token', { status: 404 }));
  const logs = [];
  const options = { signal: new AbortController().signal, log: (line) => logs.push(line) };
  await makeDiscordNotifier(webhook, options)(link, 'RTL-SDR');

  called.mock.mockImplementation(async () => { throw new Error(webhook); });
  await makeDiscordNotifier(webhook, options)(link, 'RTL-SDR');

  assert.deepEqual(logs, [
    'Discord startup notification failed (HTTP 404).',
    'Discord startup notification failed (network error or timeout).',
  ]);
});
