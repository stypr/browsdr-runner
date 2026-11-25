import { HostAudioVfo, hostAudioSettings } from './host-audio.mjs';
import { AUDIO_RATE, IQ_OVERHEAD, MAX_IQ_VALUES, iqPacket, pcmPacket } from '../remote/protocol.mjs';
import { IF_RATES, planSlice } from './iq-plan.mjs';
import { makeSpectrum } from './spectrum.mjs';
import { loadDsp } from './wasm.mjs';

const INPUT_CAPACITY = 65536;
const PCM_PACKET_FRAMES = AUDIO_RATE / 50;
const PCM_QUEUE_SECONDS = 0.08;
const MIN_VFO_BANDWIDTH = 50;
const MAX_VFOS = 8;
export const DEFAULT_IQ_QUEUE_MS = 80;

function send(channel, packet) {
  // The transport can close between isOpen() and sending on the native channel.
  try {
    channel.sendMessageBinary(packet);
    return true;
  } catch {
    return false;
  }
}

function emptyStats() {
  return { callbacks: 0, maxArrivalGapMs: 0, processingMs: 0, maxProcessingMs: 0,
    maxQueueMs: 0, discardedValues: 0, blockedBlocks: 0, sentPackets: 0, subscriberBlocks: 0, sliceRuns: 0,
    maxPcmQueueMs: 0, pcmPackets: 0, discardedPcmFrames: 0 };
}

// Share filtered IQ between matching VFOs while keeping playback queues per client.
export async function makeStreamer(inputFormat, { dspDir, queueMs = DEFAULT_IQ_QUEUE_MS, diagnostics = false, log = () => {} } = {}) {
  const dsp = await loadDsp(dspDir);
  const { memory, DspProcessor, alloc_iq_buffer, free_iq_buffer } = dsp;
  const input = alloc_iq_buffer(INPUT_CAPACITY);
  const spectrum = makeSpectrum(dsp);
  const clients = new Set();
  const slices = new Map();
  let block = 0;
  let lastArrival;
  let stats = emptyStats();

  function releaseVfo(vfo) {
    const slice = vfo.slice;
    if (slice && --slice.users === 0) {
      slice.processor?.free();
      slices.delete(slice.key);
    }
    vfo.slice = undefined;
    vfo.audio?.close();
    vfo.audio = undefined;
    vfo.discontinuity = true;
  }

  function clearVfos(client) {
    for (const vfo of client.vfos) if (vfo) releaseVfo(vfo);
  }

  function config(client, command) {
    if (command.type === 'clientStream') {
      if (command.stream !== 'iq' && command.stream !== 'audio') return;
      const iq = command.stream === 'iq';
      if (iq !== client.iq) {
        client.iq = iq;
        clearVfos(client);
      }
    } else if (command.type === 'resetRemoteVfos') {
      clearVfos(client);
      client.vfos.length = 0;
    } else if (command.type === 'removeRemoteVfo') {
      if (Number.isInteger(command.index) && command.index >= 0 && command.index < MAX_VFOS) {
        const [removed] = client.vfos.splice(command.index, 1);
        if (removed) releaseVfo(removed);
      }
    } else if (command.type === 'vfoUpdate') {
      const { params, index, revision } = command;
      if (!Number.isInteger(index) || index < 0 || index >= MAX_VFOS
        || (revision !== undefined && (!Number.isInteger(revision) || revision < 0 || revision > 0xffffffff))
        || !Object.hasOwn(IF_RATES, params?.mode)
        || !Number.isFinite(params.freq) || !Number.isFinite(params.bandwidth)
        || params.bandwidth <= 0 || params.bandwidth > 20000000) return;

      const vfo = client.vfos[index] ?? { sequence: 0 };
      if (vfo.revision !== revision || vfo.params?.enabled !== params.enabled || params.bandwidth < MIN_VFO_BANDWIDTH) releaseVfo(vfo);
      vfo.params = params.bandwidth >= MIN_VFO_BANDWIDTH ? params : undefined;
      vfo.revision = revision;
      vfo.audioSettingsDirty = true;
      client.vfos[index] = vfo;
    }
  }

  function resolveSlice(vfo, radio) {
    if (!vfo.params || vfo.revision === undefined) return null;
    if (vfo.slice !== undefined) return vfo.slice;
    const plan = planSlice(vfo.params, radio);
    if (!plan) return vfo.slice = null;
    const key = JSON.stringify([radio.centerFreq, radio.sampleRate, plan]);
    let slice = slices.get(key);
    if (!slice) {
      const direct = plan.centerFreq === radio.centerFreq && plan.sampleRate === radio.sampleRate && plan.bandwidth === radio.sampleRate;
      let processor;
      if (!direct) {
        try {
          processor = new DspProcessor(radio.sampleRate, (plan.centerFreq - radio.centerFreq) * 1e6, Math.max(plan.bandwidth, 50000));
          processor.set_if_sample_rate(plan.sampleRate);
          processor.set_bandwidth(plan.bandwidth);
        } catch (error) {
          processor?.free();
          log(`Could not start IQ slice at ${plan.centerFreq} MHz: ${error.message}`);
          return vfo.slice = null;
        }
      }
      const packetValues = Math.min(MAX_IQ_VALUES, Math.max(2, Math.floor(plan.sampleRate * 0.02) * 2));
      slice = { key, plan, processor, packetValues, users: 0, block: null, quantized: Buffer.alloc(0) };
      slices.set(key, slice);
    }
    slice.users++;
    return vfo.slice = slice;
  }

  function prepareSlice(slice, length) {
    if (slice.block === block) return;
    // Congestion can skip a block entirely. A filter cannot reuse history across that gap.
    slice.discontinuity = slice.block !== null && slice.block + 1 !== block;
    if (slice.discontinuity) slice.processor?.reset();
    slice.block = block;
    if (diagnostics) stats.sliceRuns++;
    if (!slice.processor) {
      // Make a copy because another slice's WASM allocation may grow the memory.
      if (slice.quantized.length < length) slice.quantized = Buffer.allocUnsafe(length);
      slice.quantized.set(new Uint8Array(memory.buffer, input, length));
      slice.values = length;
      slice.scale = 1 / 128;
      return;
    }

    const ptr = slice.processor.process_iq_only_ptr(input, length);
    const samples = new Float32Array(memory.buffer, ptr, slice.processor.get_iq_output_len());
    let peak = 1e-9;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    slice.scale = Math.min(100, peak / 127);
    slice.values = samples.length;
    if (slice.quantized.length < slice.values) slice.quantized = Buffer.allocUnsafe(slice.values);
    for (let i = 0; i < samples.length; i++) {
      slice.quantized[i] = Math.max(-127, Math.min(127, Math.round(samples[i] / slice.scale)));
    }
  }

  function streamIq(client, channel, radio, length) {
    let bytesPerSecond = 0;
    let maxPacket = 0;
    for (const vfo of client.vfos) {
      if (!vfo) continue;
      const slice = resolveSlice(vfo, radio);
      if (!slice || slice.failed) continue;
      bytesPerSecond += slice.plan.sampleRate * 2;
      maxPacket = Math.max(maxPacket, IQ_OVERHEAD + slice.packetValues);
    }
    if (!bytesPerSecond) return;
    const budget = Math.min(262144, Math.max(maxPacket * 2, Math.floor(bytesPerSecond * queueMs / 1000)));
    const readQueue = () => {
      const bytes = channel.bufferedAmount();
      if (diagnostics) stats.maxQueueMs = Math.max(stats.maxQueueMs, 1000 * bytes / bytesPerSecond);
      return bytes;
    };
    const count = client.vfos.length;
    // Rotate the first VFO in each block so a full channel doesn't starve later VFOs.
    const first = block % count;
    for (let current = 0; current < count; current++) {
      const index = (first + current) % count;
      const vfo = client.vfos[index];
      const slice = vfo?.slice;
      if (!slice || slice.failed) continue;
      if (diagnostics) stats.subscriberBlocks++;
      if (readQueue() + IQ_OVERHEAD + 2 > budget) {
        vfo.discontinuity = true;
        if (diagnostics) stats.blockedBlocks++;
        continue;
      }
      try {
        prepareSlice(slice, length);
      } catch (error) {
        slice.failed = true;
        log(`IQ slice at ${slice.plan.centerFreq} MHz stopped: ${error.message}`);
        continue;
      }
      vfo.discontinuity ||= slice.discontinuity;
      for (let offset = 0; offset < slice.values; offset += slice.packetValues) {
        const size = Math.min(slice.packetValues, slice.values - offset);
        if (readQueue() + IQ_OVERHEAD + size > budget) {
          vfo.discontinuity = true;
          if (diagnostics) stats.discardedValues += slice.values - offset;
          break;
        }
        const samples = slice.quantized.subarray(offset, offset + size);
        const packet = iqPacket({
          index, revision: vfo.revision, sequence: vfo.sequence, plan: slice.plan, discontinuity: vfo.discontinuity,
        }, samples, slice.scale);
        vfo.sequence = (vfo.sequence + 1) >>> 0;
        vfo.discontinuity = !send(channel, packet);
        if (diagnostics && !vfo.discontinuity) stats.sentPackets++;
      }
    }
  }

  function streamHostAudio(client, channel, radio, length) {
    const active = [];
    let available = Infinity;
    let channels = 1;
    for (const vfo of client.vfos) {
      if (!vfo?.params) continue;
      try {
        if (vfo.audio === undefined || vfo.audioSettingsDirty) {
          const settings = hostAudioSettings(vfo.params, radio);
          const key = JSON.stringify(settings);
          vfo.audioSettingsDirty = false;
          if (vfo.audio === undefined || key !== vfo.audioKey) {
            vfo.audio?.close();
            vfo.audio = null;
            vfo.audioKey = key;
            if (settings) vfo.audio = new HostAudioVfo(DspProcessor, radio.sampleRate, settings);
          }
        }
        vfo.audio?.process(memory, input, length);
      } catch (error) {
        vfo.audio?.close();
        vfo.audio = null;
        log(`Host audio at ${vfo.params.freq} MHz (${vfo.params.bandwidth} Hz) stopped: ${error.message}`);
      }
      const audio = vfo.audio;
      if (!audio) continue;
      const volume = Number.isFinite(vfo.params.volume) ? Math.max(0, Math.min(100, vfo.params.volume)) / 100 : 0.5;
      const gain = vfo.params.audioMuted === true ? 0 : volume * volume;
      available = Math.min(available, audio.queuedFrames);
      channels = Math.max(channels, audio.channels);
      active.push({ audio, gain });
    }
    if (!active.length) return;

    const budget = AUDIO_RATE * channels * 4 * PCM_QUEUE_SECONDS;
    const mix = client.pcmMix ??= new Float32Array(PCM_PACKET_FRAMES * 2);
    while (available > 0) {
      const frames = Math.min(available, PCM_PACKET_FRAMES);
      const output = mix.subarray(0, frames * channels);
      output.fill(0);
      for (const { audio, gain } of active) audio.mixInto(output, frames, channels, gain);
      const queued = channel.bufferedAmount();
      if (diagnostics) stats.maxPcmQueueMs = Math.max(stats.maxPcmQueueMs, 1000 * queued / (AUDIO_RATE * channels * 4));
      const packet = pcmPacket(output, channels);
      if (queued + packet.length <= budget && send(channel, packet)) {
        if (diagnostics) stats.pcmPackets++;
      } else if (diagnostics) stats.discardedPcmFrames += frames;
      available -= frames;
    }
  }

  function processBlock(raw, radio) {
    block++;
    const view = new Uint8Array(memory.buffer, input, raw.length);
    view.set(raw);
    if (inputFormat === 'uint8') {
      // librtlsdr uses offset bytes, while the WASM input expects signed int8 IQ.
      for (let i = 0; i < raw.length; i++) view[i] ^= 0x80;
    }
    spectrum.append(view);

    for (const client of clients) {
      const channel = client.channels.get('audio');
      if (!channel?.isOpen()) continue;
      if (client.iq) streamIq(client, channel, radio, raw.length);
      else streamHostAudio(client, channel, radio, raw.length);
    }
  }

  const remove = (client) => {
    if (clients.delete(client)) clearVfos(client);
    if (!clients.size) spectrum.reset();
  };
  return {
    add(client) {
      client.vfos = [];
      client.iq = false;
      clients.add(client);
    },
    remove,
    config,
    reset() {
      lastArrival = undefined;
      spectrum.reset();
      for (const client of clients) clearVfos(client);
    },
    samples(raw, radio) {
      const started = diagnostics ? performance.now() : 0;
      if (diagnostics) {
        stats.callbacks++;
        if (lastArrival !== undefined) stats.maxArrivalGapMs = Math.max(stats.maxArrivalGapMs, started - lastArrival);
        lastArrival = started;
      }
      if (!clients.size || !raw.length) return;
      for (let offset = 0; offset < raw.length; offset += INPUT_CAPACITY) {
        processBlock(raw.subarray(offset, offset + INPUT_CAPACITY), radio);
      }
      let spectrumFrame;
      for (const client of clients) {
        const channel = client.channels.get('fft');
        if (!channel?.isOpen()) continue;
        spectrumFrame ??= spectrum.frame(performance.now());
        if (!spectrumFrame) break;
        if (channel.bufferedAmount() < spectrumFrame.length * 2) send(channel, spectrumFrame);
      }
      if (diagnostics) {
        const elapsed = performance.now() - started;
        stats.processingMs += elapsed;
        stats.maxProcessingMs = Math.max(stats.maxProcessingMs, elapsed);
      }
    },
    takeStats() {
      const result = { ...stats, clients: clients.size, slices: slices.size };
      stats = emptyStats();
      return result;
    },
    close() {
      for (const client of clients) remove(client);
      spectrum.close();
      free_iq_buffer(input, INPUT_CAPACITY);
    },
  };
}
