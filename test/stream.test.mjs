import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FFT_SIZE, fftPacket, iqPacket, IQ_OVERHEAD } from '../src/remote/protocol.mjs';
import { makeStreamer } from '../src/dsp/stream.mjs';
import { parseOptions } from '../src/cli.mjs';

function channel() {
  return {
    pending: 0, packets: [],
    isOpen: () => true,
    bufferedAmount() { return this.pending; },
    sendMessageBinary(packet) { this.packets.push(packet); },
  };
}

function addClient(streamer, revision) {
  const audio = channel();
  const fft = channel();
  const client = { channels: new Map([['audio', audio], ['fft', fft]]) };
  streamer.add(client);
  streamer.config(client, { type: 'clientStream', stream: 'iq' });
  streamer.config(client, {
    type: 'vfoUpdate', index: 0, revision,
    params: { mode: 'wfm', freq: 100, bandwidth: 150000, enabled: true },
  });
  return { client, audio, fft };
}

test('IQ and FFT packets retain the BrowSDR wire format', () => {
  const packet = iqPacket({
    index: 2, revision: 0x01020304, sequence: 7, discontinuity: true,
    plan: { centerFreq: 100.25, sampleRate: 250000, bandwidth: 250000, fullBand: true },
  }, Buffer.from([128, 255, 0, 127]), 1 / 128);

  // Golden IQ packet encoded by the browser branch's packIqPacket().
  assert.equal(packet.toString('hex'),
    '425344520a006e61746976652d736472'
    + '42534951010803000200000004030201070000000400000000000000001059400000000080840e410000003c0024744880ff007f');
  assert.equal(fftPacket(Float32Array.of(-140, -120, -55)).toString('hex'),
    '425344520a006e61746976652d736472ffda0300000041');
});

test('lowering or disabling the waterfall leaves host audio running', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const raw = Buffer.alloc(131072, 125);
  const radio = { centerFreq: 100, sampleRate: 2400000 };
  for (const [waterfallFps, expectedFftFrames] of [[5, 2], [0, 0]]) {
    const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR, waterfallFps });
    try {
      const { client, audio, fft } = addClient(streamer, 1);
      streamer.config(client, { type: 'clientStream', stream: 'audio' });
      for (const time of [0, 50, 199, 200]) {
        now = time;
        streamer.samples(raw, radio);
      }
      assert.equal(fft.packets.length, expectedFftFrames);
      assert(audio.packets.length > 0);
      assert.notEqual(audio.packets[0].toString('ascii', 16, 20), 'BSIQ');
    } finally {
      streamer.close();
    }
  }
});

test('the runner sends 60 spectrum FPS by default and honors lower overrides', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const raw = Buffer.alloc(131072, 128);
  const radio = { centerFreq: 100, sampleRate: 2400000 };
  for (const [args, expectedFps] of [[[], 60], [['--waterfall-fps', '30'], 30], [['--waterfall-fps', '20'], 20]]) {
    const options = parseOptions(args, {});
    const streamer = await makeStreamer('uint8', { ...options, dspDir: process.env.BROWSDR_DSP_DIR });
    try {
      const fft = channel();
      streamer.add({ channels: new Map([['fft', fft]]) });
      for (let tick = 0; tick < 60; tick++) {
        now = tick * 1000 / 60;
        streamer.samples(raw, radio);
      }
      assert.equal(fft.packets.length, expectedFps);
    } finally {
      streamer.close();
    }
  }
  assert.throws(() => parseOptions(['--waterfall-fps', '61'], {}), /0 to 60/);
});

test('identical slices share DSP while congestion is isolated to the slow subscriber', async () => {
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR, diagnostics: true });
  try {
    const first = addClient(streamer, 11);
    const second = addClient(streamer, 25);
    const radio = { centerFreq: 100, sampleRate: 2048000 };
    const raw = Buffer.alloc(24576, 125);
    streamer.samples(raw, radio);
    assert.equal(first.audio.packets.length, 1);
    assert.equal(second.audio.packets.length, 1);
    assert.deepEqual(first.audio.packets[0].subarray(IQ_OVERHEAD), second.audio.packets[0].subarray(IQ_OVERHEAD));
    assert.equal(first.audio.packets[0].readUInt32LE(IQ_OVERHEAD - 36), 11);
    assert.equal(second.audio.packets[0].readUInt32LE(IQ_OVERHEAD - 36), 25);
    let stats = streamer.takeStats();
    assert.equal(stats.sliceRuns, 1);
    assert.equal(stats.subscriberBlocks, 2);
    assert.equal(stats.slices, 1);

    first.audio.pending = 100000;
    streamer.samples(raw, radio);
    assert.equal(first.audio.packets.length, 1);
    assert.equal(second.audio.packets.length, 2);
    stats = streamer.takeStats();
    assert.equal(stats.blockedBlocks, 1);
    assert.equal(stats.sliceRuns, 1);

    first.audio.pending = 0;
    streamer.samples(raw, radio);
    assert.equal(first.audio.packets.at(-1)[IQ_OVERHEAD - 42] & 1, 1);
    assert.equal(second.audio.packets.at(-1)[IQ_OVERHEAD - 42] & 1, 0);

    streamer.remove(first.client);
    assert.equal(streamer.takeStats().slices, 1);
    streamer.remove(second.client);
    assert.equal(streamer.takeStats().slices, 0);
  } finally {
    streamer.close();
  }
});

test('the remote spectrum accumulates, smooths and reduces FFT bins across capture blocks', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR });
  const radio = { centerFreq: 100, sampleRate: 3200000 };
  const fft = channel();
  const analysisSize = 65536;
  const toneBin = 4109;
  const displayBin = FFT_SIZE / 2 + Math.floor(toneBin * FFT_SIZE / analysisSize);
  const tone = (amplitude) => {
    const raw = Buffer.alloc(analysisSize * 2);
    for (let i = 0; i < analysisSize; i++) {
      const phase = 2 * Math.PI * i * toneBin / analysisSize;
      raw[i * 2] = 128 + Math.round(amplitude * Math.cos(phase));
      raw[i * 2 + 1] = 128 + Math.round(amplitude * Math.sin(phase));
    }
    return raw;
  };
  try {
    streamer.add({ channels: new Map([['fft', fft]]) });
    const strong = tone(96);
    const weak = tone(24);
    streamer.samples(strong.subarray(0, 8190), radio);
    assert.equal(fft.packets.length, 0);
    streamer.samples(strong.subarray(8190), radio);
    assert.equal(fft.packets.length, 1);
    const first = fft.packets[0].subarray(-FFT_SIZE);
    assert.equal(first.indexOf(Math.max(...first)), displayBin);

    now = 10;
    streamer.samples(Buffer.alloc(6016, 128), radio);
    assert.equal(fft.packets.length, 1);
    now = 50;
    streamer.samples(weak, radio);
    assert.equal(fft.packets.length, 2);
    const smoothed = fft.packets[1].subarray(-FFT_SIZE);
    assert.ok(Math.abs(first[displayBin] - smoothed[displayBin] - 7) <= 1);

    streamer.reset();
    streamer.samples(weak.subarray(0, 8190), radio);
    assert.equal(fft.packets.length, 2);
    streamer.samples(weak.subarray(8190), radio);
    assert.equal(fft.packets.length, 3);
    const reset = fft.packets[2].subarray(-FFT_SIZE);
    assert.ok(Math.abs(first[displayBin] - reset[displayBin] - 12) <= 1);
  } finally {
    streamer.close();
  }
});

test('a narrow VFO keeps a wider transport filter and an invalid width only suspends that VFO', async () => {
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR });
  try {
    const narrow = addClient(streamer, 11);
    const other = addClient(streamer, 25);
    const radio = { centerFreq: 100, sampleRate: 2048000 };
    const raw = Buffer.alloc(24576, 133);
    const update = (bandwidth, revision) => streamer.config(narrow.client, {
      type: 'vfoUpdate', index: 0, revision,
      params: { mode: 'cw', freq: 100.04, bandwidth, enabled: true },
    });

    update(200, 12);
    streamer.samples(raw, radio);
    assert.equal(narrow.audio.packets.at(-1).readDoubleLE(IQ_OVERHEAD - 16), 50000);
    assert.equal(narrow.audio.packets.at(-1).readFloatLE(IQ_OVERHEAD - 4), 6250);

    update(0.001, 13);
    streamer.samples(raw, radio);
    assert.equal(narrow.audio.packets.length, 1);
    assert.equal(other.audio.packets.length, 2);

    update(50, 14);
    streamer.samples(raw, radio);
    assert.equal(narrow.audio.packets.length, 2);
    assert.equal(narrow.audio.packets.at(-1).readUInt32LE(IQ_OVERHEAD - 36), 14);
  } finally {
    streamer.close();
  }
});
