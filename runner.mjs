import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, usage } from './src/cli.mjs';
import { RtlTcpCapture } from './src/capture/rtl-tcp.mjs';
import { Capture } from './src/capture/subprocess.mjs';
import { makeStreamer } from './src/dsp/stream.mjs';
import { makeDiscordNotifier } from './src/integrations/discord.mjs';
import { loadIdentity, saveIdentity } from './src/remote/identity.mjs';
import { FFT_SIZE, RECEIVER_ID } from './src/remote/protocol.mjs';
import { loadPeerFactory } from './src/remote/transport/peer-engine.mjs';
import { describeAudioTransport, loadIceServers, openSignaling } from './src/remote/transport/signaling.mjs';

function log(message) {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  const options = parseOptions();
  if (!options) {
    console.log(usage);
    return;
  }
  const { site, backend, device, headers } = options;
  const { engine, createPeer } = await loadPeerFactory(options.webrtc, log);
  log(`WebRTC engine: ${engine}.`);
  const signalController = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => signalController.abort());
  const { signal } = signalController;
  const notifyDiscord = makeDiscordNotifier(process.env.BROWSDR_DISCORD_WEBHOOK_URL, { signal, log });
  const radio = { centerFreq: options.frequency / 1e6, frequencyShift: 0, sampleRate: options.sampleRate, fftSize: FFT_SIZE };
  const gains = Object.fromEntries(device.capabilities.gainControls.map((gain) => [gain.name, gain.default]));
  const liveControls = device.capabilities.deviceType === 'rtlsdr';
  // Keep live requests separate from the settings that describe the current IQ stream.
  const requestedRadio = liveControls ? { ...radio } : radio;
  const requestedGains = liveControls ? { ...gains } : gains;
  const locks = Object.fromEntries(['centerFreq', 'sampleRate', ...Object.keys(gains)].map((key) => [key, options.locked]));
  const clients = new Set();
  const streamer = await makeStreamer(device.capabilities.sampleFormat, { ...options, log });
  const statsTimer = options.diagnostics ? setInterval(async () => {
    const stats = streamer.takeStats();
    log(`Stats (10s): clients=${stats.clients}, IQ slices=${stats.slices}, capture callbacks=${stats.callbacks}, `
      + `capture gap max=${stats.maxArrivalGapMs.toFixed(1)}ms, DSP/send work=${stats.processingMs.toFixed(0)}ms `
      + `(callback max ${stats.maxProcessingMs.toFixed(1)}ms), IQ queue max≈${stats.maxQueueMs.toFixed(1)}ms, `
      + `blocked blocks=${stats.blockedBlocks}, discarded IQ values=${stats.discardedValues}, accepted IQ packets=${stats.sentPackets}, `
      + `slice runs=${stats.sliceRuns}/${stats.subscriberBlocks} subscriptions, `
      + `accepted PCM packets=${stats.pcmPackets}, PCM queue max≈${stats.maxPcmQueueMs.toFixed(1)}ms (limit ${options.pcmQueueMs}ms), `
      + `discarded PCM frames=${stats.discardedPcmFrames}, `
      + (engine === 'libdatachannel' ? `packets queued by native channel=${stats.nativeQueuedPackets}, ` : '')
      + `native send errors=${stats.sendErrors}.`);
    if (clients.size) {
      const paths = await Promise.all(Array.from(clients, async (client) =>
        `${client.iq ? 'IQ' : 'PCM'} ${await describeAudioTransport(client)}`));
      if (!signal.aborted) log(`Audio transport (per client): ${paths.join(' | ')}`);
    }
  }, 10000) : undefined;
  let receiving = false;
  let registeredCode;
  let announced = false;
  function announce() {
    // Capture and PeerServer can become ready in either order.
    if (!receiving || !registeredCode || announced) return;
    const link = new URL(site);
    link.searchParams.set('connect', registeredCode);
    console.log(`Connect code: ${registeredCode}\n${link.href}`);
    announced = true;
    void notifyDiscord?.(link, device.name);
  }
  const inventory = () => ({
    type: 'receivers',
    receivers: [{ id: RECEIVER_ID, name: device.name, running: receiving, radio, gains, locks, capabilities: device.capabilities }],
  });
  const broadcast = () => {
    for (const client of clients) client.sendCommand(inventory());
  };
  const CaptureDriver = liveControls ? RtlTcpCapture : Capture;
  const capture = new CaptureDriver(device, options.serial, log, (samples) => {
    if (receiving) streamer.samples(samples, radio);
  }, (active) => {
    receiving = active;
    streamer.reset();
    broadcast();
    if (active) {
      log(`Receiving ${device.name} at ${radio.centerFreq} MHz, ${radio.sampleRate} samples/s.`);
      announce();
    }
  }, ({ radio: nextRadio, gains: nextGains }) => {
    if (receiving && (nextRadio.centerFreq !== radio.centerFreq || nextRadio.sampleRate !== radio.sampleRate)) streamer.reset();
    Object.assign(radio, nextRadio);
    Object.assign(gains, nextGains);
    if (receiving) broadcast();
  });

  function onCommand(client, command) {
    if (!command || typeof command !== 'object' || (command.receiverId !== undefined && command.receiverId !== RECEIVER_ID)) return;
    if (command.type !== 'requestChange') {
      streamer.config(client, command);
      return;
    }
    const { target, property, value } = command;
    if (!Object.hasOwn(locks, property) || locks[property] || !Number.isFinite(value)) {
      client.sendCommand({ type: 'sync', receiverId: RECEIVER_ID, radio, gains, locks });
      return;
    }
    let settings;
    if (target === 'radio' && property === 'centerFreq') {
      const [min, max] = device.capabilities.frequencyRange;
      const hz = Math.round(value * 1e6);
      if (hz >= min && hz <= max) settings = [requestedRadio, hz / 1e6];
    } else if (target === 'radio' && property === 'sampleRate' && device.capabilities.sampleRates.includes(value)) {
      settings = [requestedRadio, value];
    } else if (target === 'gains') {
      const control = device.capabilities.gainControls.find((gain) => gain.name === property);
      if (control && value >= control.min && value <= control.max) {
        const step = (value - control.min) / control.step;
        if (Math.abs(step - Math.round(step)) < 1e-6) settings = [requestedGains, value];
      }
    }
    if (!settings || settings[0][property] === settings[1]) return;
    settings[0][property] = settings[1];
    if (!liveControls) {
      receiving = false;
      broadcast();
    }
    capture.configure(requestedRadio, requestedGains);
  }

  try {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const pathSuffix = site.pathname === '/' ? '' : `-${createHash('sha256').update(site.pathname).digest('hex').slice(0, 12)}`;
    const identityPath = join(options.stateDir, `${site.host.replaceAll(':', '_')}${pathSuffix}-${device.capabilities.deviceType}.json`);
    const identity = await loadIdentity(identityPath);
    await saveIdentity(identityPath, identity);
    capture.configure(requestedRadio, requestedGains);

    let retry = 1000;
    while (!signal.aborted) {
      let reason;
      try {
        const iceServers = await loadIceServers(backend, headers, signal);
        reason = await openSignaling({
          site, backend, headers, ...identity, iceServers, createPeer, signal, relayOnly: options.relayOnly, log,
          onOpen() {
            retry = 1000;
            registeredCode = identity.code;
            announce();
          },
          onClient(client) {
            streamer.add(client);
            clients.add(client);
            client.sendCommand(inventory());
            client.sendCommand({ type: 'streamCapabilities', receiverId: RECEIVER_ID, iqSlices: true });
            log(`Remote client connected (${clients.size} active).`);
          },
          onCommand,
          onLeave(client) {
            streamer.remove(client);
            clients.delete(client);
          },
        });
      } catch (error) {
        reason = error.message;
      }
      registeredCode = undefined;
      announced = false;
      if (signal.aborted) break;
      // A stale registration can survive a network outage. Retry our own code and token.
      log(`${reason}. Reconnecting in ${retry / 1000}s.`);
      await delay(retry, undefined, { signal });
      retry = Math.min(retry * 2, 30000);
    }
  } finally {
    clearInterval(statsTimer);
    await capture.close();
    streamer.close();
  }
}

try {
  await main();
} catch (error) {
  if (error.name !== 'AbortError') {
    log(error.message);
    process.exitCode = 1;
  }
}
