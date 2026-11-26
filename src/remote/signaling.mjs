import WebSocket from 'ws';
import { pack, unpack } from 'peerjs-js-binarypack';

// The browser opens one PeerJS data connection for each logical stream.
const LABELS = new Set(['cmd', 'fft', 'audio']);
const MAX_SIGNAL = 65536;
const MAX_CLIENTS = 8;
const audioRateSamples = new WeakMap();

export function signalingAddress(site, backend, code, token) {
  // The official BrowSDR frontend uses PeerJS Cloud; the LAN build uses its own PeerServer.
  const address = site.hostname.endsWith('.jlynx.net')
    ? new URL('wss://0.peerjs.com/peerjs')
    : new URL('signal/peerjs', backend);
  address.protocol = 'wss:';
  address.search = new URLSearchParams({ key: 'peerjs', id: `browsdr-${code}`, token, version: '1.5.5' });
  return address;
}

export async function loadIceServers(backend, headers, signal) {
  const endpoint = new URL('api/turn', backend);
  const response = await fetch(endpoint, {
    headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw new Error(`GET ${endpoint.pathname} returned HTTP ${response.status}`);
  const { iceServers } = await response.json();
  if (!Array.isArray(iceServers)) throw new Error(`Missing iceServers in ${endpoint.pathname}`);
  return iceServers.flatMap((entry) => {
    const urls = [entry?.urls].flat().filter((uri) => typeof uri === 'string' && /^(stun|turns?):/i.test(uri));
    if (!urls.length) return [];
    return [{
      urls,
      ...(typeof entry.username === 'string' ? { username: entry.username } : {}),
      ...(typeof entry.credential === 'string' ? { credential: entry.credential } : {}),
    }];
  });
}

function nativeTransportStats(pc) {
  const pair = pc.getSelectedCandidatePair();
  if (!pair) return null;
  return {
    route: `${pair.local.type}/${pair.local.transportType} → ${pair.remote.type}/${pair.remote.transportType}`,
    rtt: pc.rtt(),
    bytes: pc.bytesSent(),
    rateLabel: 'SCTP input',
  };
}

export async function describeAudioTransport(client, now = performance.now()) {
  const audio = [...client.connections.values()].find(({ label }) => label === 'audio');
  if (!audio) return 'path unavailable';
  try {
    const { pc } = audio;
    const stats = pc.transportStats ? await pc.transportStats() : nativeTransportStats(pc);
    if (!stats) return 'path unavailable';
    const { route, rtt, rateLabel, bytes } = stats;
    const previous = audioRateSamples.get(pc);
    audioRateSamples.set(pc, { bytes, now });
    const rate = previous && bytes >= previous.bytes && now > previous.now
      ? `${Math.round(8 * (bytes - previous.bytes) / (now - previous.now))} kbps`
      : 'unavailable';
    return `${route}, RTT ${rtt >= 0 ? `${rtt} ms` : 'unavailable'}, ${rateLabel} ${rate}`;
  } catch {
    // A closing native connection can stop reporting statistics between polls.
    return 'path unavailable';
  }
}

export function openSignaling({ site, backend, headers, code, token, iceServers, relayOnly, createPeer, signal, onOpen, onClient, onCommand, onLeave, log }) {
  const address = signalingAddress(site, backend, code, token);
  // Never forward a site's proxy credentials to an external PeerServer.
  const signalHeaders = address.origin === `wss://${backend.host}` ? headers : {};
  const ws = new WebSocket(address, { headers: signalHeaders, maxPayload: MAX_SIGNAL, handshakeTimeout: 10000 });
  const clients = new Map();
  let closeError = 'Signaling disconnected';
  let pong = true;
  const openTimer = setTimeout(() => {
    closeError = 'PeerServer did not acknowledge registration';
    ws.terminate();
  }, 15000);
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!pong) {
      closeError = 'PeerServer WebSocket did not reply to ping';
      ws.terminate();
      return;
    }
    pong = false;
    ws.ping();
    sendSignal({ type: 'HEARTBEAT' });
  }, 5000);
  const stop = () => ws.terminate();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();

  function sendSignal(message) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_SIGNAL) ws.send(JSON.stringify(message));
  }

  function drop(id) {
    const client = clients.get(id);
    if (!client) return;
    clients.delete(id);
    clearTimeout(client.timer);
    for (const { pc } of client.connections.values()) pc.close();
    onLeave(client);
  }

  function getClient(id) {
    if (clients.has(id)) return clients.get(id);
    if (clients.size >= MAX_CLIENTS) return null;
    const client = { id, channels: new Map(), connections: new Map(), ready: false };
    client.timer = setTimeout(() => drop(id), 20000);
    client.sendCommand = (message) => {
      const channel = client.channels.get('cmd');
      if (!channel?.isOpen() || channel.bufferedAmount() > MAX_SIGNAL) return;
      const bytes = pack(message);
      if (bytes instanceof ArrayBuffer) channel.sendMessageBinary(Buffer.from(bytes));
    };
    clients.set(id, client);
    return client;
  }

  function negotiationFailed(client, error) {
    if (clients.get(client.id) !== client) return;
    log(`Peer negotiation failed: ${error.message}`);
    drop(client.id);
  }

  function offer(src, payload) {
    const { label, connectionId, sdp, type } = payload;
    if (type !== 'data' || !LABELS.has(label) || sdp?.type !== 'offer' || typeof sdp.sdp !== 'string') return;
    const client = getClient(src);
    if (!client) return;
    if (client.connections.has(connectionId)) return;
    if ([...client.connections.values()].some((connection) => connection.label === label)) return;
    const pc = createPeer(`${src}/${label}`, {
      iceServers, maxMessageSize: MAX_SIGNAL, iceTransportPolicy: relayOnly ? 'relay' : 'all',
    });
    client.connections.set(connectionId, { label, pc });
    const active = () => clients.get(src) === client;
    const retire = () => queueMicrotask(() => { if (active()) drop(src); });
    pc.onLocalDescription((sdp, type) => {
      if (active()) sendSignal({ type: 'ANSWER', dst: src, payload: { type: 'data', connectionId, sdp: { sdp, type } } });
    });
    pc.onLocalCandidate((candidate, sdpMid) => {
      if (active()) sendSignal({
        type: 'CANDIDATE', dst: src,
        payload: { type: 'data', connectionId, candidate: { candidate, sdpMid, sdpMLineIndex: 0 } },
      });
    });
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') retire();
    });
    pc.onDataChannel((channel) => {
      if (!active() || channel.getLabel() !== label || client.channels.has(label)) {
        channel.close();
        return;
      }
      client.channels.set(label, channel);
      const ready = () => {
        // Announce the receiver once the client can receive commands and both data streams.
        if (!active() || client.ready || ![...LABELS].every((name) => client.channels.get(name)?.isOpen())) return;
        client.ready = true;
        clearTimeout(client.timer);
        onClient(client);
      };
      channel.onOpen(ready);
      channel.onClosed(retire);
      channel.onError(retire);
      if (label === 'cmd') channel.onMessage((bytes) => {
        if (!active() || !client.ready || !Buffer.isBuffer(bytes) || bytes.length > 16384) return;
        try {
          const command = unpack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          onCommand(client, command);
        } catch {
          // Ignore messages outside the command protocol.
        }
      });
      ready();
    });
    Promise.resolve(pc.setRemoteDescription(sdp.sdp, 'offer')).catch((error) => negotiationFailed(client, error));
  }

  ws.on('pong', () => { pong = true; });
  ws.on('error', (error) => { closeError = `Signaling ${address.origin}${address.pathname}: ${error.message}`; });
  ws.on('message', (bytes) => {
    let src;
    try {
      const message = JSON.parse(bytes);
      ({ src } = message);
      if (message.type === 'OPEN') {
        clearTimeout(openTimer);
        onOpen();
        return;
      }
      if (['ID-TAKEN', 'INVALID-KEY', 'ERROR'].includes(message.type)) {
        closeError = `PeerServer: ${message.type}`;
        ws.close();
        return;
      }
      if (typeof src !== 'string' || !src || src.length > 128) return;
      if (message.type === 'LEAVE') {
        drop(src);
        return;
      }
      const { payload } = message;
      if (typeof payload?.connectionId !== 'string' || payload.connectionId.length > 128) return;
      if (message.type === 'OFFER') offer(src, payload);
      if (message.type === 'CANDIDATE') {
        const client = clients.get(src);
        const connection = client?.connections.get(payload.connectionId);
        const { candidate, sdpMid } = payload.candidate ?? {};
        if (connection && typeof candidate === 'string' && candidate && typeof sdpMid === 'string') {
          Promise.resolve(connection.pc.addRemoteCandidate(candidate, sdpMid)).catch((error) => negotiationFailed(client, error));
        }
      }
    } catch (error) {
      if (src && clients.has(src)) negotiationFailed(clients.get(src), error);
    }
  });

  return new Promise((resolve) => ws.once('close', () => {
    clearInterval(heartbeat);
    clearTimeout(openTimer);
    signal.removeEventListener('abort', stop);
    for (const id of clients.keys()) drop(id);
    resolve(closeError);
  }));
}
