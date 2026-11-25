import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signalingAddress } from '../src/remote/signaling.mjs';

/*
test('the local site signals through its own PeerServer', () => {
  const address = signalingAddress(new URL('https://sdr.internal/'), '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://sdr.internal/signal/peerjs');
  assert.equal(address.searchParams.get('id'), 'browsdr-0123456789abcdef0123');
});
*/

test('the official site signals through PeerJS Cloud', () => {
  const address = signalingAddress(new URL('https://browsdr.jlynx.net/'), '0123456789abcdef0123', 'token');
  assert.equal(address.origin + address.pathname, 'wss://0.peerjs.com/peerjs');
  assert.equal(address.searchParams.get('id'), 'browsdr-0123456789abcdef0123');
});
