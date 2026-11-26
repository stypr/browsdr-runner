import { PeerConnection } from 'node-datachannel';
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
  const servers = [];
  for (const entry of iceServers) {
    for (const uri of [entry.urls].flat()) {
      if (typeof uri !== 'string' || !/^(stun|turns?):/i.test(uri)) continue;
      if (uri.startsWith('stun:')) {
        servers.push(uri);
        continue;
      }
      const url = new URL(uri.replace(/^turns?:/i, 'http://'));
      const tls = uri.startsWith('turns:');
      servers.push({
        hostname: url.hostname, port: Number(url.port || (tls ? 5349 : 3478)),
        username: entry.username, password: entry.credential,
        relayType: tls ? 'TurnTls' : url.searchParams.get('transport') === 'tcp' ? 'TurnTcp' : 'TurnUdp',
      });
    }
  }
  return servers;
}

export function describeAudioTransport(client, now = performance.now()) {
  const audio = [...client.connections.values()].find(({ label }) => label === 'audio');
  if (!audio) return 'path unavailable';
  try {
    const { pc } = audio;
    const pair = pc.getSelectedCandidatePair();
    if (!pair) return 'path unavailable';
    const rtt = pc.rtt();
    const route = `${pair.local.type}/${pair.local.transportType} → ${pair.remote.type}/${pair.remote.transportType}`;
    const bytes = pc.bytesSent();
    const previous = audioRateSamples.get(pc);
    audioRateSamples.set(pc, { bytes, now });
    const rate = previous && bytes >= previous.bytes && now > previous.now
      ? `${Math.round(8 * (bytes - previous.bytes) / (now - previous.now))} kbps`
      : 'unavailable';
    return `${route}, RTT ${rtt >= 0 ? `${rtt} ms` : 'unavailable'}, SCTP input ${rate}`;
  } catch {
    // A closing native connection can stop reporting statistics between polls.
    return 'path unavailable';
  }
}

export function openSignaling({ site, backend, headers, code, token, iceServers, relayOnly, signal, onOpen, onClient, onCommand, onLeave, log }) {
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

  function offer(src, payload) {
    const { label, connectionId, sdp, type } = payload;
    if (type !== 'data' || !LABELS.has(label) || sdp?.type !== 'offer' || typeof sdp.sdp !== 'string') return;
    const client = getClient(src);
    if (!client) return;
    if (client.connections.has(connectionId)) return;
    if ([...client.connections.values()].some((connection) => connection.label === label)) return;
    const pc = new PeerConnection(`${src}/${label}`, {
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
    pc.setRemoteDescription(sdp.sdp, 'offer');
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
        const connection = clients.get(src)?.connections.get(payload.connectionId);
        const { candidate, sdpMid } = payload.candidate ?? {};
        if (connection && typeof candidate === 'string' && candidate && typeof sdpMid === 'string') {
          connection.pc.addRemoteCandidate(candidate, sdpMid);
        }
      }
    } catch (error) {
      if (src && clients.has(src)) {
        log(`Peer negotiation failed: ${error.message}`);
        drop(src);
      }
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
