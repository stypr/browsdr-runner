import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ExpressPeerServer } from 'peer';

function basePath(value) {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#')) {
    throw new Error('BrowSDR paths must be absolute directory paths on this origin.');
  }
  return value.endsWith('/') ? value : `${value}/`;
}

const appBase = basePath(process.env.BROWSDR_BASE_PATH || '/');
const backendBase = basePath(process.env.BROWSDR_BACKEND_BASE || appBase);
const endpoint = (base, path) => `${base}${path}`;

const { TURN_LAN_IP, TURN_PASSWORD } = process.env;
if (!isIPv4(TURN_LAN_IP ?? '') || !TURN_PASSWORD) {
  throw new Error('Set TURN_LAN_IP to the TURN server LAN IPv4 address and set TURN_PASSWORD.');
}
const turnAddress = `${TURN_LAN_IP}:3478`;
const iceServers = [
  { urls: `stun:${turnAddress}` },
  {
    urls: [`turn:${turnAddress}?transport=udp`, `turn:${turnAddress}?transport=tcp`],
    username: 'browsdr',
    credential: TURN_PASSWORD,
  },
];

const app = express();
const server = createServer(app);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  next();
});
app.use(endpoint(backendBase, 'signal'), ExpressPeerServer(server, { proxied: true, allow_discovery: false }));
app.get(endpoint(backendBase, 'api/turn'), (_req, res) => res.set('Cache-Control', 'no-store').json({ iceServers }));
app.get(endpoint(backendBase, 'api/geo'), (_req, res) => res.json({ country: 'KR' }));
if (appBase !== '/') {
  app.get(appBase.slice(0, -1), (req, res, next) => {
    if (req.path === appBase) return next();
    return res.redirect(308, `${appBase}${req.url.slice(req.path.length)}`);
  });
}
app.use(appBase, express.static(fileURLToPath(new URL('./dist/', import.meta.url))));

server.listen(8080, '0.0.0.0', () => {
  console.log(`BrowSDR ${appBase} and PeerServer ${endpoint(backendBase, 'signal')} listening on HTTP port 8080`);
});
