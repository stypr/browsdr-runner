import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const HOST = '127.0.0.1';
const HEADER_BYTES = 12;
const CONTROL_INTERVAL_MS = 200;
const IQ_TIMEOUT_MS = 8000;
const GAIN = 'Tuner Gain';
// Stock rtl_tcp uses librtlsdr's default 256 KiB async transfer size.
const USB_BLOCK_BYTES = 256 * 1024;
// Osmocom's rtlsdr_get_tuner_gains tables, indexed by the tuner type in RTL0.
const R82XX_GAINS = [0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280,
  297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496];
const TUNER_GAINS = [
  undefined,
  [-10, 15, 40, 65, 90, 115, 140, 165, 190, 215, 240, 290, 340, 420],
  [-99, -40, 71, 179, 192],
  [-99, -73, -65, -63, -60, -58, -54, 58, 61, 63, 65, 67, 68, 70, 71, 179, 181, 182, 184, 186, 188, 191, 197],
  undefined,
  R82XX_GAINS,
  R82XX_GAINS,
];

async function availablePort() {
  const server = createServer();
  server.listen(0, HOST);
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function rfChanged(current, next) {
  return current.radio.sampleRate !== next.radio.sampleRate || current.radio.centerFreq !== next.radio.centerFreq;
}

function nearestGain(steps, gain) {
  const tenths = Math.round(gain * 10);
  return steps?.reduce((best, step) => Math.abs(step - tenths) < Math.abs(best - tenths) ? step : best) ?? tenths;
}

function controlCommands(current, next, steps) {
  const commands = [];
  if (current.radio.sampleRate !== next.radio.sampleRate) commands.push([0x02, next.radio.sampleRate]);
  if (current.radio.centerFreq !== next.radio.centerFreq) commands.push([0x01, Math.round(next.radio.centerFreq * 1e6)]);
  const oldGain = current.gains[GAIN];
  const gain = next.gains[GAIN];
  if ((oldGain === 0) !== (gain === 0)) commands.push([0x03, gain === 0 ? 0 : 1]);
  if (gain !== 0 && gain !== oldGain) {
    const setting = nearestGain(steps, gain);
    if (oldGain === 0 || setting !== nearestGain(steps, oldGain)) commands.push([0x04, setting]);
  }
  const buffer = Buffer.alloc(commands.length * 5);
  for (const [index, [command, value]] of commands.entries()) {
    buffer[index * 5] = command;
    buffer.writeUInt32BE(value >>> 0, index * 5 + 1);
  }
  return buffer;
}

// Keep the USB device open while sending control commands over a loopback socket.
export class RtlTcpCapture {
  constructor(device, selection, log, onSamples, onStatus, onSettings) {
    this.device = device;
    this.selection = selection;
    this.log = log;
    this.onSamples = onSamples;
    this.onStatus = onStatus;
    this.onSettings = onSettings;
    this.controller = new AbortController();
  }

  configure(radio, gains) {
    this.desired = { radio: { ...radio }, gains: { ...gains } };
    this.task ??= this.run();
    if (this.session) this.scheduleControl(this.session);
  }

  async run() {
    const { signal } = this.controller;
    let retry = 1000;
    while (!signal.aborted) {
      const started = performance.now();
      try {
        await this.runSession(signal);
      } catch (error) {
        this.log(`${this.device.command}: ${error.message}`);
      }
      if (signal.aborted) break;
      if (performance.now() - started >= 30000) retry = 1000;
      await delay(retry, undefined, { signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
      retry = Math.min(retry * 2, 30000);
    }
  }

  async runSession(signal) {
    const port = await availablePort();
    if (signal.aborted) return;
    const session = {
      applied: this.desired, header: Buffer.alloc(HEADER_BYTES), headerLength: 0, lastIq: performance.now(),
      resumeAt: 0,
    };
    const { radio, gains } = session.applied;
    const args = this.device.args(Math.round(radio.centerFreq * 1e6), radio.sampleRate, gains, this.selection, HOST, port);
    const child = spawn(this.device.command, args.map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.session = session;
    const { promise: ended, resolve: end } = Promise.withResolvers();
    const stop = () => end();
    signal.addEventListener('abort', stop, { once: true });
    let output = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4096); });
    child.on('error', (error) => end(error.message));
    const { promise: exited, resolve: onExit } = Promise.withResolvers();
    child.on('close', (code, name) => {
      onExit();
      end(`exited (${name ?? code})`);
    });

    const connect = () => {
      const socket = createConnection({ host: HOST, port });
      session.socket = socket;
      socket.setNoDelay(true);
      let failure;
      socket.on('error', (error) => { failure = error; });
      socket.on('data', (raw) => this.readIq(session, raw, end));
      socket.on('close', () => {
        if (session.stopping) return;
        if (failure?.code === 'ECONNREFUSED' && session.headerLength === 0) {
          session.connectTimer = setTimeout(connect, 100);
        } else {
          end(failure?.message ?? 'IQ socket closed');
        }
      });
    };
    connect();
    const watchdog = setInterval(() => {
      if (performance.now() - session.lastIq >= IQ_TIMEOUT_MS) end(`No IQ from ${this.device.command}; restarting capture.`);
    }, 1000);
    const reason = await ended;
    session.stopping = true;
    clearInterval(watchdog);
    clearTimeout(session.connectTimer);
    clearTimeout(session.controlTimer);
    this.session = undefined;
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    session.socket?.destroy();
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    if (session.active) this.onStatus(false);
    // The retry loop can spawn another child only after this one releases USB.
    await exited;
    clearTimeout(killTimer);
    const detail = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' | ');
    if (reason && !signal.aborted) this.log(`${this.device.command}: ${reason}${detail ? ` (${detail})` : ''}`);
  }

  readIq(session, raw, end) {
    // The RTL0 header can span multiple TCP reads or share a read with IQ.
    if (session.headerLength < HEADER_BYTES) {
      const count = Math.min(raw.length, HEADER_BYTES - session.headerLength);
      raw.copy(session.header, session.headerLength, 0, count);
      session.headerLength += count;
      if (session.headerLength < HEADER_BYTES) return;
      if (session.header.toString('ascii', 0, 4) !== 'RTL0') {
        end('invalid RTL0 header');
        return;
      }
      const steps = TUNER_GAINS[session.header.readUInt32BE(4)];
      if (steps?.length === session.header.readUInt32BE(8)) session.gainSteps = steps;
      raw = raw.subarray(count);
    }
    if (!raw.length) return;
    const now = performance.now();
    session.lastIq = now;
    const samples = session.oddByte === undefined ? raw : Buffer.concat([Buffer.from([session.oddByte]), raw]);
    const length = samples.length - samples.length % 2;
    session.oddByte = length === samples.length ? undefined : samples[length];
    if (!length || now < session.resumeAt) {
      // Keep alignment, but do not pair a discarded I byte with a later Q.
      session.discardPair = now < session.resumeAt && session.oddByte !== undefined;
      return;
    }
    const start = session.discardPair ? 2 : 0;
    session.discardPair = false;
    if (length <= start) return;
    if (session.resumeAt) {
      session.resumeAt = 0;
      this.publishSettings(session, session.pending);
    }
    if (!session.active) {
      session.active = true;
      this.onSettings(session.applied);
      this.onStatus(true);
      this.scheduleControl(session);
    }
    this.onSamples(samples.subarray(start, length));
  }

  scheduleControl(session) {
    if (!session.active || session.pending || session.controlTimer || session.socket.destroyed || session.applied === this.desired) return;
    // Leave the timer in place during a burst so continuous changes still take effect.
    session.controlTimer = setTimeout(() => {
      session.controlTimer = undefined;
      const next = this.desired;
      const commands = controlCommands(session.applied, next, session.gainSteps);
      if (!commands.length) {
        if (next.gains[GAIN] !== session.applied.gains[GAIN]) this.publishSettings(session, next);
        else session.applied = next;
        return;
      }
      if (session.socket.destroyed) return;
      session.pending = next;
      const retuning = rfChanged(session.applied, next);
      if (retuning) session.resumeAt = Infinity;
      session.socket.write(commands, (error) => {
        if (session.stopping) return;
        if (error) {
          session.socket.destroy(error);
          return;
        }
        if (retuning) {
          // There is no command ACK or sample marker. Discard approximately two USB blocks at the slower rate.
          const rate = Math.min(session.applied.radio.sampleRate, next.radio.sampleRate);
          session.resumeAt = performance.now() + 1000 * USB_BLOCK_BYTES / rate;
          return;
        }
        this.publishSettings(session, next);
      });
    }, CONTROL_INTERVAL_MS);
  }

  publishSettings(session, next) {
    session.applied = next;
    session.pending = undefined;
    this.onSettings(session.applied);
    this.scheduleControl(session);
  }

  async close() {
    this.controller.abort();
    await this.task;
  }
}
