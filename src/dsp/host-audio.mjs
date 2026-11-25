import { AUDIO_RATE } from '../remote/protocol.mjs';

const FM_RATES = { nfm: 50000, wfm: 250000 };
const OTHER_MODES = new Set(['am', 'usb', 'lsb', 'dsb', 'cw', 'raw']);
const DEEMPHASIS_SECONDS = { '22us': 22e-6, '50us': 50e-6, '75us': 75e-6 };
const NARROW_IF_RATES = [3000, 6000, 12000, 24000, AUDIO_RATE];
// A 64 KiB input block at the slowest supported capture rate yields up to 6292 PCM frames.
const QUEUE_FRAMES = 8192;

export const HOST_AUDIO_DSP_METHODS = [
  'process_ptr', 'get_output_len', 'set_squelch', 'get_squelch_db',
  'set_wfm_mode', 'set_stereo', 'set_audio_filters',
];

export function hostAudioSettings(params, radio) {
  if (params.enabled !== true) return null;
  const mode = params.mode;
  const fm = Object.hasOwn(FM_RATES, mode);
  if (!fm && !OTHER_MODES.has(mode)) return null;

  const nominalRate = FM_RATES[mode] ?? AUDIO_RATE;
  const bandwidth = Math.min(params.bandwidth, nominalRate, radio.sampleRate);
  // Stereo multiplex occupies the channel out to 53 kHz on both sides.
  const stereo = mode === 'wfm' && params.stereo === true && bandwidth >= 106000;
  const wideFm = mode === 'wfm' && bandwidth >= 30000;
  let ifRate = nominalRate;
  if (mode === 'wfm' && !stereo && bandwidth < 80000) {
    ifRate = bandwidth <= 40000 ? 50000 : 125000;
  }
  if (!wideFm && bandwidth < 6000) {
    // The WASM channel FIR's tap count grows with IF rate / bandwidth.
    ifRate = NARROW_IF_RATES.find((rate) => rate >= bandwidth * 8) ?? ifRate;
  }
  const sideband = mode === 'usb' ? bandwidth / 2 : mode === 'lsb' ? -bandwidth / 2 : 0;
  const shift = (params.freq - radio.centerFreq) * 1e6 + sideband;
  if (Math.abs(shift) + bandwidth / 2 > radio.sampleRate / 2) return null;
  return {
    mode, fm, stereo, wideFm, ifRate, shift, sideband, bandwidth,
    squelchEnabled: params.squelchEnabled === true,
    squelchLevel: Number.isFinite(params.squelchLevel) ? params.squelchLevel : -100,
    lowPass: params.lowPass === true,
    highPass: params.highPass === true,
    deemphasis: Object.hasOwn(DEEMPHASIS_SECONDS, params.deEmphasis) ? DEEMPHASIS_SECONDS[params.deEmphasis] : 0,
  };
}

// Non-FM demodulation uses channel-filtered IQ at 48 kHz directly. The signal path
// matches the BrowSDR worker's AM envelope and carrier-relative sideband detection.
export class HostAudioVfo {
  constructor(DspProcessor, sourceRate, settings) {
    const { bandwidth, shift, ifRate, stereo, fm, mode, wideFm, lowPass, highPass, squelchLevel, squelchEnabled } = settings;
    const processor = new DspProcessor(sourceRate, shift, Math.max(bandwidth, 50000));
    try {
      processor.set_if_sample_rate(ifRate);
      processor.set_bandwidth(bandwidth);
      if (fm) {
        processor.set_squelch(squelchLevel, squelchEnabled);
        processor.set_wfm_mode(wideFm);
        processor.set_stereo(stereo);
        processor.set_audio_filters(lowPass || mode === 'wfm', highPass);
      }
    } catch (error) {
      processor.free();
      throw error;
    }
    this.processor = processor;
    this.settings = settings;
    this.channels = stereo ? 2 : 1;
    this.queue = new Float32Array(QUEUE_FRAMES * this.channels);
    this.queuedFrames = 0;
    this.interpolation = fm ? 1 : AUDIO_RATE / ifRate;
    if (this.interpolation > 1) this.interpolatedIq = new Float32Array(QUEUE_FRAMES * 2);
    this.previousI = 0;
    this.previousQ = 0;
    this.history = new Float32Array(this.channels);
    this.dc = 0;
    this.phase = 0;
    this.gain = 1;
  }

  process(memory, input, inputLength) {
    const { processor, settings, channels } = this;
    const pointer = settings.fm ? processor.process_ptr(input, inputLength) : processor.process_iq_only_ptr(input, inputLength);
    const length = settings.fm ? processor.get_output_len() : processor.get_iq_output_len();
    let incoming = new Float32Array(memory.buffer, pointer, length);
    if (this.interpolatedIq) incoming = this.interpolateIq(incoming);
    const frames = incoming.length / (settings.fm ? channels : 2);
    if (!frames) return;

    const overflow = Math.max(0, this.queuedFrames + frames - QUEUE_FRAMES);
    const queuedDrop = Math.min(this.queuedFrames, overflow);
    const skip = overflow - queuedDrop;
    if (queuedDrop) this.queue.copyWithin(0, queuedDrop * channels, this.queuedFrames * channels);
    this.queuedFrames -= queuedDrop;
    const offset = this.queuedFrames * channels;
    const output = this.queue.subarray(offset, offset + (frames - skip) * channels);
    if (settings.fm) this.appendFm(incoming, skip * channels, output);
    else this.appendAnalog(incoming, skip, output);
    this.queuedFrames += frames - skip;
  }

  interpolateIq(samples) {
    const output = this.interpolatedIq;
    const ratio = this.interpolation;
    let offset = 0;
    // Interpolate narrow baseband IQ before moving it up to the CW audio tone.
    for (let i = 0; i < samples.length; i += 2) {
      const re = samples[i];
      const im = samples[i + 1];
      for (let step = 1; step <= ratio; step++) {
        output[offset++] = this.previousI + (re - this.previousI) * step / ratio;
        output[offset++] = this.previousQ + (im - this.previousQ) * step / ratio;
      }
      this.previousI = re;
      this.previousQ = im;
    }
    return output.subarray(0, offset);
  }

  appendFm(samples, skip, output) {
    const { channels, history, settings } = this;
    if (settings.squelchEnabled && this.processor.get_squelch_db() < settings.squelchLevel) {
      output.fill(0);
      history.fill(0);
      return;
    }
    const alpha = 1 / (1 + settings.deemphasis * AUDIO_RATE);
    for (let i = 0; i < samples.length; i++) {
      const channel = i % channels;
      history[channel] += alpha * (samples[i] - history[channel]);
      if (i >= skip) output[i - skip] = history[channel];
    }
  }

  appendAnalog(samples, skip, output) {
    const { mode, sideband, squelchEnabled, squelchLevel } = this.settings;
    if (squelchEnabled) {
      let magnitude = 0;
      for (let i = 0; i < samples.length; i += 2) magnitude += Math.hypot(samples[i], samples[i + 1]);
      if (10 * Math.log10(2 * magnitude / samples.length + 1e-12) < squelchLevel) {
        output.fill(0);
        return;
      }
    }
    const phaseStep = (mode === 'cw' ? 700 : sideband) * 2 * Math.PI / AUDIO_RATE;
    for (let i = 0; i < samples.length / 2; i++) {
      const re = samples[i * 2];
      const im = samples[i * 2 + 1];
      let value = re;
      if (mode === 'am') {
        const magnitude = Math.hypot(re, im);
        this.dc += (magnitude - this.dc) * 0.0001;
        value = magnitude - this.dc;
      } else if (phaseStep) {
        value = re * Math.cos(this.phase) - im * Math.sin(this.phase);
        this.phase += phaseStep;
        if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
        if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
      }
      if (mode !== 'raw') {
        const magnitude = Math.abs(value);
        this.gain += (magnitude - this.gain) * (magnitude > this.gain ? 50 : 5) / AUDIO_RATE;
        if (this.gain > 1e-6) value *= 0.5 / this.gain;
      }
      if (i >= skip) output[i - skip] = value;
    }
  }

  mixInto(mix, frames, channels, gain) {
    for (let frame = 0; frame < frames; frame++) {
      const index = frame * this.channels;
      mix[frame * channels] += this.queue[index] * gain;
      if (channels === 2) mix[frame * 2 + 1] += this.queue[index + this.channels - 1] * gain;
    }
    this.queuedFrames -= frames;
    if (this.queuedFrames) {
      this.queue.copyWithin(0, frames * this.channels, (frames + this.queuedFrames) * this.channels);
    }
  }

  close() {
    this.processor.free();
  }
}
