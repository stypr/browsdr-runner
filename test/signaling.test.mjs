import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadIceServers, signalingAddress } from '../src/remote/transport/signaling.mjs';

test('the local site signals through its own PeerServer', () => {
  const site = new URL('https://sdr.internal/');
  const address = signalingAddress(site, site, '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://sdr.internal/signal/peerjs');
  assert.equal(address.searchParams.get('id'), 'browsdr-0123456789abcdef0123');
});

test('subdirectory site signals below its backend base', () => {
  const site = new URL('https://sdr.internal/sdr/');
  const address = signalingAddress(site, site, '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://sdr.internal/sdr/signal/peerjs');
});

test('backend override keeps signaling at the configured root', () => {
  const site = new URL('https://sdr.internal/sdr/');
  const address = signalingAddress(site, new URL('https://sdr.internal/'), '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://sdr.internal/signal/peerjs');
});

test('TURN discovery uses the selected backend directory', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => ({ iceServers: [] }) };
  };
  try {
    const signal = new AbortController().signal;
    await loadIceServers(new URL('https://sdr.internal/sdr/'), {}, signal);
    await loadIceServers(new URL('https://sdr.internal/'), {}, signal);
    assert.deepEqual(requested, ['https://sdr.internal/sdr/api/turn', 'https://sdr.internal/api/turn']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the official site signals through PeerJS Cloud', () => {
  const site = new URL('https://browsdr.jlynx.net/');
  const address = signalingAddress(site, site, '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://0.peerjs.com/peerjs');
  assert.equal(address.searchParams.get('id'), 'browsdr-0123456789abcdef0123');
});
