import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, original, replacement) {
  const source = readFileSync(path, 'utf8');
  const first = source.indexOf(original);
  if (first < 0 || source.indexOf(original, first + original.length) !== -1) {
    throw new Error(`Expected one match in ${path}; review this patch against the selected BrowSDR ref.`);
  }
  writeFileSync(path, source.replace(original, replacement));
}

// Keep upstream TURN loading, including backendPath and response validation.
replaceOnce(
  'src/client/remote/webrtc.ts',
  '\t\t\t\tconst peerOpts = peerConfig ? { config: peerConfig } : {};',
  `\t\t\t\tconst signalingUrl = new URL(backendPath('signal'), window.location.href);
\t\t\t\tconst peerOpts = {
\t\t\t\t\thost: signalingUrl.hostname,
\t\t\t\t\tport: Number(signalingUrl.port || (signalingUrl.protocol === 'https:' ? 443 : 80)),
\t\t\t\t\tsecure: signalingUrl.protocol === 'https:',
\t\t\t\t\tpath: signalingUrl.pathname,
\t\t\t\t\t...(peerConfig ? { config: peerConfig } : {}),
\t\t\t\t};`,
);

// A short ICE interruption should not tear down all three remote channels.
replaceOnce(
  'src/client/remote/webrtc.ts',
  `\t\t\t\tconst pc: RTCPeerConnection | undefined = client.cmd.peerConnection;
\t\t\t\tif (pc) {
\t\t\t\t\tpc.addEventListener('iceconnectionstatechange', () => {
\t\t\t\t\t\tif (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
\t\t\t\t\t\t\tif (this.clients.has(clientId)) {
\t\t\t\t\t\t\t\tconsole.log(\`[WebRTC] ICE state "\${pc.iceConnectionState}" for \${clientId.substring(0, 8)}, cleaning up\`);
\t\t\t\t\t\t\t\tthis._cleanupClient(clientId);
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t});
\t\t\t\t}`,
  `\t\t\t\tconst pc: RTCPeerConnection | undefined = client.cmd.peerConnection;
\t\t\t\tif (pc) {
\t\t\t\t\tlet disconnectTimer: ReturnType<typeof setTimeout> | undefined;
\t\t\t\t\tconst clearDisconnectTimer = () => {
\t\t\t\t\t\tclearTimeout(disconnectTimer);
\t\t\t\t\t\tdisconnectTimer = undefined;
\t\t\t\t\t};
\t\t\t\t\tconst cleanup = () => {
\t\t\t\t\t\tif (this.clients.get(clientId) === client) this._cleanupClient(clientId);
\t\t\t\t\t};
\t\t\t\t\tclient.cmd.on('close', clearDisconnectTimer);
\t\t\t\t\tpc.addEventListener('iceconnectionstatechange', () => {
\t\t\t\t\t\tif (this.clients.get(clientId) !== client) return;
\t\t\t\t\t\tconst state = pc.iceConnectionState;
\t\t\t\t\t\tif (state === 'disconnected') {
\t\t\t\t\t\t\tif (disconnectTimer !== undefined) return;
\t\t\t\t\t\t\tdisconnectTimer = setTimeout(() => {
\t\t\t\t\t\t\t\tdisconnectTimer = undefined;
\t\t\t\t\t\t\t\tif (pc.iceConnectionState === 'disconnected') cleanup();
\t\t\t\t\t\t\t}, 10000);
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tclearDisconnectTimer();
\t\t\t\t\t\tif (state === 'failed' || state === 'closed') cleanup();
\t\t\t\t\t});
\t\t\t\t}`,
);

// LAN sites may be reachable while the browser's online flag is false.
replaceOnce(
  'src/client/app/templates/shell.html',
  `:disabled="!isOnline" :title="!isOnline ? 'Not available offline' : 'Share remote access via WebRTC'"`,
  'title="Share remote access via WebRTC"',
);
