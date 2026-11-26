import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { devices } from './capture/devices.mjs';
import { DEFAULT_WATERFALL_FPS } from './dsp/spectrum.mjs';
import { DEFAULT_IQ_QUEUE_MS, DEFAULT_PCM_QUEUE_MS } from './dsp/stream.mjs';

const DEFAULT_URL = 'https://browsdr.jlynx.net/';
const MAX_PCM_QUEUE_MS = 5000;

export const usage = `Usage: node runner.mjs [options]
  --url URL             BrowSDR HTTPS site (default: ${DEFAULT_URL})
  --backend-url URL     Backend base URL if API and PeerServer are mounted elsewhere
  --device TYPE         rtl-sdr (default) or hackrf
  --serial ID           RTL index/serial or HackRF serial
  --frequency HZ        Initial center frequency (default: 99900000)
  --sample-rate HZ      Initial sample rate (RTL: 3200000, HackRF: 20000000)
  --state-dir DIR       Persistent share identity directory
  --dsp-dir DIR         Use a specific BrowSDR WASM bundle directory
  --iq-queue-ms MS      Target native IQ send queue (default: ${DEFAULT_IQ_QUEUE_MS})
  --pcm-queue-ms MS     Host audio send queue limit, 40–${MAX_PCM_QUEUE_MS} ms (default: ${DEFAULT_PCM_QUEUE_MS})
  --waterfall-fps FPS   Remote spectrum and waterfall rate, 0 to disable (default: ${DEFAULT_WATERFALL_FPS})
  --stats               Print capture, DSP, queue and audio transport stats every 10 seconds
  --keep-locks          Keep shared RF controls locked
  --relay-only          Use TURN relay candidates on the native host
  --webrtc ENGINE       auto (prefers libwebrtc), libwebrtc, or libdatachannel
  --help                Display usage

Environment:
  BROWSDR_AUTH_ORIGIN          HTTPS origin allowed to receive Authorization/Cookie headers
  BROWSDR_DISCORD_WEBHOOK_URL  Post the connect link to Discord when the runner is ready
`;

export function parseOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string', default: DEFAULT_URL },
    'backend-url': { type: 'string' },
    device: { type: 'string', default: 'rtl-sdr' },
    serial: { type: 'string' },
    frequency: { type: 'string' },
    'sample-rate': { type: 'string' },
    'state-dir': { type: 'string' },
    'dsp-dir': { type: 'string' },
    'iq-queue-ms': { type: 'string' },
    'pcm-queue-ms': { type: 'string' },
    'waterfall-fps': { type: 'string' },
    stats: { type: 'boolean' },
    'keep-locks': { type: 'boolean' },
    'relay-only': { type: 'boolean' },
    webrtc: { type: 'string', default: 'auto' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return null;
  const parseBase = (value, option) => {
    const base = new URL(value);
    if (base.protocol !== 'https:' || base.username || base.password || !base.pathname.endsWith('/') || base.search || base.hash) {
      throw new Error(`${option} must be an HTTPS directory URL ending in /.`);
    }
    return base;
  };
  const site = parseBase(values.url, '--url');
  const backend = values['backend-url'] ? parseBase(values['backend-url'], '--backend-url') : site;
  if (!Object.hasOwn(devices, values.device)) throw new Error('--device must be rtl-sdr or hackrf.');
  const device = devices[values.device];
  if (values.serial !== undefined && !/^[a-z0-9_-]{1,80}$/i.test(values.serial)) throw new Error('Invalid --serial.');
  const frequency = Number(values.frequency ?? device.defaults.frequency);
  const sampleRate = Number(values['sample-rate'] ?? device.defaults.rate);
  const [min, max] = device.capabilities.frequencyRange;
  if (!Number.isSafeInteger(frequency) || frequency < min || frequency > max) throw new Error('Invalid --frequency for the selected SDR.');
  if (!device.capabilities.sampleRates.includes(sampleRate)) {
    throw new Error(`Supported --sample-rate values: ${device.capabilities.sampleRates.join(', ')}`);
  }
  const queueMs = Number(values['iq-queue-ms'] ?? DEFAULT_IQ_QUEUE_MS);
  if (!Number.isInteger(queueMs) || queueMs < 40 || queueMs > 250) {
    throw new Error('--iq-queue-ms must be an integer from 40 to 250.');
  }
  const pcmQueueMs = Number(values['pcm-queue-ms'] ?? DEFAULT_PCM_QUEUE_MS);
  if (!Number.isInteger(pcmQueueMs) || pcmQueueMs < 40 || pcmQueueMs > MAX_PCM_QUEUE_MS) {
    throw new Error(`--pcm-queue-ms must be an integer from 40 to ${MAX_PCM_QUEUE_MS}.`);
  }
  const waterfallFps = Number(values['waterfall-fps'] ?? DEFAULT_WATERFALL_FPS);
  if (values['waterfall-fps'] === '' || !Number.isInteger(waterfallFps) || waterfallFps < 0 || waterfallFps > DEFAULT_WATERFALL_FPS) {
    throw new Error(`--waterfall-fps must be an integer from 0 to ${DEFAULT_WATERFALL_FPS}.`);
  }
  if (!['auto', 'libwebrtc', 'libdatachannel'].includes(values.webrtc)) {
    throw new Error('--webrtc must be auto, libwebrtc, or libdatachannel.');
  }
  const dspDir = values['dsp-dir'] === undefined ? undefined : resolve(values['dsp-dir']);
  const stateDir = resolve(values['state-dir'] ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'browsdr-runner'));
  const authSite = new URL(env.BROWSDR_AUTH_ORIGIN || DEFAULT_URL);
  if (authSite.protocol !== 'https:' || authSite.username || authSite.password
    || authSite.pathname !== '/' || authSite.search || authSite.hash) {
    throw new Error('BROWSDR_AUTH_ORIGIN must be an HTTPS origin.');
  }
  const headers = {};
  if (backend.origin === authSite.origin) {
    if (env.BROWSDR_AUTHORIZATION) headers.Authorization = env.BROWSDR_AUTHORIZATION;
    if (env.BROWSDR_COOKIE) headers.Cookie = env.BROWSDR_COOKIE;
  }
  return {
    site, backend, device, serial: values.serial, frequency, sampleRate, stateDir, headers, dspDir, queueMs, pcmQueueMs, waterfallFps,
    diagnostics: !!values.stats, webrtc: values.webrtc,
    locked: !!values['keep-locks'], relayOnly: !!values['relay-only'],
  };
}
