import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const RETUNE_DEBOUNCE_MS = 125;

// Capture IQ from a tool whose RF settings are fixed at process start.
export class Capture {
  constructor(device, selection, log, onSamples, onStatus) {
    this.device = device;
    this.selection = selection;
    this.log = log;
    this.onSamples = onSamples;
    this.onStatus = onStatus;
    this.current = null;
    this.retry = 1000;
    this.running = false;
  }

  configure(radio, gains) {
    this.settings = { ...radio, gains: { ...gains } };
    clearTimeout(this.timer);
    if (!this.current) {
      this.start();
      return;
    }
    this.retuneAt = Date.now() + RETUNE_DEBOUNCE_MS;
    this.timer = setTimeout(() => this.stopChild(), RETUNE_DEBOUNCE_MS);
  }

  start() {
    if (this.closed || this.current) return;
    const settings = this.settings;
    const { centerFreq, sampleRate, gains } = settings;
    const args = this.device.args(Math.round(centerFreq * 1e6), sampleRate, gains, this.selection).map(String);
    const child = spawn(this.device.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.current = child;
    let lastSample = Date.now();
    let output = '';
    let previousByte;
    let startupBytes = 0;
    child.stdout.on('data', (raw) => {
      // A retune invalidates samples from the old settings before the child exits.
      if (this.current !== child || this.stopping || this.settings !== settings) return;
      lastSample = Date.now();
      const samples = previousByte === undefined ? raw : Buffer.concat([Buffer.from([previousByte]), raw]);
      previousByte = samples.length % 2 ? samples.at(-1) : undefined;
      const length = samples.length & ~1;
      if (!this.running) {
        // The native tool can print a short help message to stdout on startup failure.
        startupBytes += length;
        if (startupBytes < 32768) return;
        this.running = true;
        this.retry = 1000;
        this.onStatus(true);
      }
      if (length) this.onSamples(samples.subarray(0, length));
    });
    child.stderr.on('data', (data) => { output = (output + data.toString()).slice(-4096); });
    child.on('error', (error) => { output = error.message; });
    const watchdog = setInterval(() => {
      if (Date.now() - lastSample <= 8000 || this.stopping) return;
      this.log(`No IQ from ${this.device.command}; restarting capture.`);
      this.stopChild();
    }, 2000);
    child.on('close', (code) => {
      clearInterval(watchdog);
      clearTimeout(this.killTimer);
      clearTimeout(this.timer);
      this.current = null;
      if (this.running) {
        this.running = false;
        this.onStatus(false);
      }
      if (this.closed) return;
      const stopped = this.stopping;
      this.stopping = false;
      if (!stopped || code) {
        const reason = output.trim().split('\n').filter(Boolean).at(-1);
        this.log(`${this.device.command} exited${code === null ? '' : ` (${code})`}${reason ? `: ${reason}` : ''}.`);
      }
      if (this.settings !== settings) {
        // A settings change only needs the previous process to release USB.
        this.timer = setTimeout(() => this.start(), Math.max(0, this.retuneAt - Date.now()));
        return;
      }
      this.timer = setTimeout(() => this.start(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    });
  }

  stopChild() {
    const child = this.current;
    if (!child || this.stopping) return;
    this.stopping = true;
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.current) return;
    this.stopChild();
    while (this.current) await delay(50);
  }
}
