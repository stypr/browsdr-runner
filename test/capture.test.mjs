import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { devices } from '../src/capture/devices.mjs';
import { Capture } from '../src/capture/subprocess.mjs';
import { RtlTcpCapture } from '../src/capture/rtl-tcp.mjs';

test('a configured retune restarts promptly after the old process closes', async () => {
  const status = new EventEmitter();
  const starts = [];
  const capture = new Capture({
    command: process.execPath,
    args: (hz) => {
      starts.push(hz);
      return ['--input-type=commonjs', '-e', 'setInterval(() => process.stdout.write(Buffer.alloc(32768)), 10)'];
    },
  }, undefined, () => {}, () => {}, (active) => { if (active) status.emit('receiving'); });
  try {
    const first = once(status, 'receiving', { signal: AbortSignal.timeout(2500) });
    capture.configure({ centerFreq: 100, sampleRate: 2048000 }, {});
    await first;
    const next = once(status, 'receiving', { signal: AbortSignal.timeout(1100) });
    capture.configure({ centerFreq: 100.1, sampleRate: 2048000 }, {});
    await next;
    assert.deepEqual(starts, [100000000, 100100000]);
  } finally {
    await capture.close();
  }
});

const mockRtlTcp = `
  import { createServer } from 'node:net';
  const [host, port] = process.argv.slice(1);
  const server = createServer((socket) => {
    const header = Buffer.alloc(12);
    header.write('RTL0');
    header.writeUInt32BE(5, 4);
    header.writeUInt32BE(29, 8);
    socket.write(header.subarray(0, 3));
    const interval = setInterval(() => socket.write(Buffer.alloc(2049, 42)), 10);
    setTimeout(() => socket.write(Buffer.concat([header.subarray(3), Buffer.alloc(2049, 42)])), 1);
    socket.on('close', () => clearInterval(interval));
    let received = Buffer.alloc(0);
    const commands = [];
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 5) {
        const command = received[0];
        const value = received.readUInt32BE(1);
        received = received.subarray(5);
        commands.push(command + '=' + value);
        if (command === 1 && value === 101000000) process.stderr.write(commands.join(', '), () => process.exit(4));
      }
    });
  });
  server.listen(Number(port), host);
`;

test('RTL startup errors retain the USB error before the exit summary', { timeout: 4000 }, async () => {
  const events = new EventEmitter();
  const capture = new RtlTcpCapture({
    command: process.execPath,
    args: () => ['-e', `
      process.stderr.write('usb_claim_interface error -6\\nFailed to open rtlsdr device #0.\\n', () => process.exit(1));
    `],
  }, undefined, (message) => events.emit('log', message), () => {}, () => {}, () => {});
  try {
    const logged = once(events, 'log', { signal: AbortSignal.timeout(2500) });
    capture.configure({ centerFreq: 100, sampleRate: 2048000 }, { 'Tuner Gain': 0 });
    const [message] = await logged;
    assert.match(message, /exited \(1\) \(usb_claim_interface error -6 \| Failed to open rtlsdr device #0\.\)/);
  } finally {
    await capture.close();
  }
});

test('RTL coalesces live controls and only restarts when capture fails', { timeout: 8000 }, async () => {
  const events = new EventEmitter();
  const statuses = [];
  const starts = [];
  const settings = [];
  const log = [];
  let sampleChunks = 0;
  const gain = (value) => ({ 'Tuner Gain': value });
  const radio = { centerFreq: 100, sampleRate: 3200000 };
  const capture = new RtlTcpCapture({
    command: process.execPath,
    args: (hz, rate, gains, selection, host, port) => {
      starts.push(devices['rtl-sdr'].args(hz, rate, gains, selection, host, port));
      return ['--input-type=module', '-e', mockRtlTcp, host, port];
    },
  }, 'test-serial', (message) => log.push(message), (samples) => {
    assert.equal(samples.length % 2, 0);
    assert.ok(samples.every((byte) => byte === 42), 'only IQ bytes reach the samples callback');
    sampleChunks++;
  }, (active) => {
    statuses.push(active);
    if (active) events.emit('receiving');
  }, (snapshot) => {
    settings.push(snapshot);
    events.emit('settings', snapshot);
  });
  const next = (name) => once(events, name, { signal: AbortSignal.timeout(3000) });
  try {
    const first = next('receiving');
    capture.configure(radio, gain(0));
    await first;
    assert.deepEqual(starts[0].slice(0, 5), ['-d', 'test-serial', '-a', '127.0.0.1', '-p']);

    const samplesBeforeGain = sampleChunks;
    const gainUpdate = next('settings');
    for (let step = 1; step <= 20; step++) {
      capture.configure(radio, gain(step));
      await delay(4);
    }
    assert.deepEqual(await gainUpdate, [{ radio, gains: gain(20) }]);
    assert.ok(sampleChunks > samplesBeforeGain);

    const sameStep = next('settings');
    capture.configure(radio, gain(19.8));
    assert.deepEqual(await sameStep, [{ radio, gains: gain(19.8) }]);

    const retuned = next('settings');
    const changedRadio = { centerFreq: 100.5, sampleRate: 2048000 };
    capture.configure(changedRadio, gain(19.8));
    assert.deepEqual(await retuned, [{ radio: changedRadio, gains: gain(19.8) }]);
    const auto = next('settings');
    capture.configure(changedRadio, gain(0));
    assert.deepEqual(await auto, [{ radio: changedRadio, gains: gain(0) }]);
    assert.equal(starts.length, 1);
    assert.deepEqual(statuses, [true]);

    const recovered = next('receiving');
    const recoveryRadio = { ...changedRadio, centerFreq: 101 };
    capture.configure(recoveryRadio, gain(0));
    await recovered;
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1].slice(6), ['-f', 101000000, '-s', 2048000, '-g', 0, '-n', 2]);
    assert.deepEqual(statuses, [true, false, true]);
    assert.deepEqual(settings.at(-1), { radio: recoveryRadio, gains: gain(0) });
    assert.ok(log.some((message) => message.includes('(3=1, 4=197, 2=2048000, 1=100500000, 3=0, 1=101000000)')));
  } finally {
    await capture.close();
  }
});
