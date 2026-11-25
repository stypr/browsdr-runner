import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO_RATE, pcmPacket } from '../src/remote/protocol.mjs';
import { makeStreamer } from '../src/dsp/stream.mjs';

const radio = { centerFreq: 100, sampleRate: 2048000 };
const freq = 100.04;
const samplesPerBlock = 12288;
const tone = 1000;
const envelopeSize = 16;

function audioClient(streamer) {
  const audio = {
    packets: [], pending: 0,
    isOpen: () => true,
    bufferedAmount() { return this.pending; },
    sendMessageBinary(packet) { this.packets.push(packet); },
  };
  const client = { channels: new Map([['audio', audio]]) };
  streamer.add(client);
  return { audio, client };
}

function decodePcm(packets) {
  return packets.flatMap((packet) => {
    const payload = packet.subarray(envelopeSize);
    const stereo = payload.toString('ascii', 0, 4) === 'SDR2';
    const values = [];
    for (let offset = stereo ? 16 : 0; offset < payload.length; offset += stereo ? 8 : 4) {
      values.push(payload.readFloatLE(offset));
    }
    return values;
  });
}

function setVfo(streamer, client, mode, extras = {}, revision) {
  streamer.config(client, {
    type: 'vfoUpdate', index: 0, revision,
    params: { mode, freq, bandwidth: mode === 'wfm' ? 150000 : 12000, enabled: true, volume: 100, ...extras },
  });
}

function inputSignal(mode, modulationHz = tone, deviationHz = 4000) {
  let phase = 0;
  let frames = 0;
  const carrier = 40000 + (mode === 'usb' || mode === 'raw' ? tone : mode === 'lsb' ? -tone : 0);
  return () => {
    const block = Buffer.allocUnsafe(samplesPerBlock * 2);
    for (let i = 0; i < block.length; i += 2) {
      const mod = Math.sin(2 * Math.PI * modulationHz * frames++ / radio.sampleRate);
      const fm = mode === 'wfm' || mode === 'nfm' ? deviationHz * mod : 0;
      phase += 2 * Math.PI * (carrier + fm) / radio.sampleRate;
      const amplitude = mode === 'am' ? 75 * (1 + 0.45 * mod) : mode === 'dsb' ? 100 * mod : 80;
      block[i] = 128 + Math.round(amplitude * Math.cos(phase));
      block[i + 1] = 128 + Math.round(amplitude * Math.sin(phase));
    }
    return block;
  };
}

function toneAmplitude(samples, hz) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = i * 2 * Math.PI * hz / AUDIO_RATE;
    re += samples[i] * Math.cos(phase);
    im += samples[i] * Math.sin(phase);
  }
  return 2 * Math.hypot(re, im) / samples.length;
}

test('host PCM keeps the mono and SDR2 stereo packet formats', () => {
  assert.equal(pcmPacket(Float32Array.of(0.5, -0.5), 1).subarray(envelopeSize).toString('hex'), '0000003f000000bf');
  assert.equal(pcmPacket(Float32Array.of(0.5, -0.5), 2).subarray(envelopeSize).toString('hex'),
    '53445232010000000200000080bb00000000003f000000bf');
});

for (const mode of ['wfm', 'nfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw']) {
  test(`host demodulates ${mode.toUpperCase()} to 48 kHz PCM without an IQ revision`, async () => {
    const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR });
    try {
      const { audio, client } = audioClient(streamer);
      setVfo(streamer, client, mode, { stereo: mode === 'wfm' });
      const input = inputSignal(mode);
      for (let i = 0; i < 16; i++) streamer.samples(input(), radio);
      audio.packets.length = 0;
      for (let i = 0; i < 32; i++) streamer.samples(input(), radio);
      const samples = decodePcm(audio.packets);
      assert(Math.abs(samples.length - 32 * samplesPerBlock * AUDIO_RATE / radio.sampleRate) < 48);
      const target = mode === 'cw' ? 700 : tone;
      assert(toneAmplitude(samples, target) > 0.015, 'expected demodulated tone');
      assert(toneAmplitude(samples, target) > 5 * toneAmplitude(samples, 1800), 'tone remains at the original frequency');
    } finally {
      streamer.close();
    }
  });
}

test('host mute and queue limits are respected and decoding can switch to IQ and back', async () => {
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR, diagnostics: true });
  try {
    const { audio, client } = audioClient(streamer);
    const input = inputSignal('nfm');
    setVfo(streamer, client, 'nfm', { audioMuted: true }, 7);
    for (let i = 0; i < 8; i++) streamer.samples(input(), radio);
    const muted = decodePcm(audio.packets);
    assert(muted.length > 0);
    assert(muted.every((value) => value === 0));

    audio.packets.length = 0;
    audio.pending = 50000;
    streamer.samples(input(), radio);
    assert.equal(audio.packets.length, 0);
    assert(streamer.takeStats().discardedPcmFrames > 0);
    audio.pending = 0;

    setVfo(streamer, client, 'nfm', {}, 7);
    streamer.config(client, { type: 'clientStream', stream: 'iq' });
    streamer.samples(input(), radio);
    assert.equal(audio.packets[0].toString('ascii', envelopeSize, envelopeSize + 4), 'BSIQ');

    audio.packets.length = 0;
    streamer.config(client, { type: 'clientStream', stream: 'audio' });
    for (let i = 0; i < 16; i++) streamer.samples(input(), radio);
    assert(toneAmplitude(decodePcm(audio.packets), tone) > 0.015);
  } finally {
    streamer.close();
  }
});

test('host CW handles a narrow channel and recovers after a sub-Hz setting', async () => {
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR });
  try {
    const { audio, client } = audioClient(streamer);
    const input = inputSignal('cw');
    setVfo(streamer, client, 'cw', { bandwidth: 0.001 });
    streamer.samples(input(), radio);
    assert.equal(audio.packets.length, 0);

    setVfo(streamer, client, 'cw', { bandwidth: 200 });
    for (let i = 0; i < 64; i++) streamer.samples(input(), radio);
    audio.packets.length = 0;
    for (let i = 0; i < 32; i++) streamer.samples(input(), radio);
    const samples = decodePcm(audio.packets);
    assert(Math.abs(samples.length - 32 * samplesPerBlock * AUDIO_RATE / radio.sampleRate) < 16);
    assert(toneAmplitude(samples, 700) > 0.1);
    assert(toneAmplitude(samples, 1800) < 0.01);
  } finally {
    streamer.close();
  }
});

test('host narrow FM still demodulates and uses mono below the stereo multiplex width', async () => {
  const streamer = await makeStreamer('uint8', { dspDir: process.env.BROWSDR_DSP_DIR });
  try {
    for (const mode of ['nfm', 'wfm']) {
      const { audio, client } = audioClient(streamer);
      setVfo(streamer, client, mode, { bandwidth: 1000, stereo: true });
      const input = inputSignal(mode, 250, 100);
      for (let i = 0; i < 32; i++) streamer.samples(input(), radio);
      audio.packets.length = 0;
      for (let i = 0; i < 32; i++) streamer.samples(input(), radio);
      assert.notEqual(audio.packets[0].toString('ascii', envelopeSize, envelopeSize + 4), 'SDR2');
      const samples = decodePcm(audio.packets);
      assert(Math.abs(samples.length - 32 * samplesPerBlock * AUDIO_RATE / radio.sampleRate) < 16);
      assert(toneAmplitude(samples, 250) > 0.1);
      streamer.remove(client);
    }
  } finally {
    streamer.close();
  }
});
