import { FFT_SIZE, fftPacket } from '../remote/protocol.mjs';

// Match the browser host's FFT and peak reduction to the remote display bins.
const ANALYSIS_SIZE = 65536;
const IQ_BYTES = ANALYSIS_SIZE * 2;
const BINS_PER_OUTPUT_BIN = ANALYSIS_SIZE / FFT_SIZE;
const FRAME_INTERVAL_MS = 50;

export function makeSpectrum({ FFT, memory, alloc_iq_buffer, free_iq_buffer }) {
  const window = Float32Array.from({ length: ANALYSIS_SIZE }, (_, i) => {
    const phase = 2 * Math.PI * i / ANALYSIS_SIZE;
    return 0.355768 - 0.487396 * Math.cos(phase) + 0.144232 * Math.cos(2 * phase) - 0.012604 * Math.cos(3 * phase);
  });
  const fft = new FFT(ANALYSIS_SIZE, window);
  const input = alloc_iq_buffer(IQ_BYTES);
  const ring = new Uint8Array(IQ_BYTES);
  const smoothed = new Float32Array(ANALYSIS_SIZE);
  const reduced = new Float32Array(FFT_SIZE);
  let position = 0;
  let filled = 0;
  let lastFrame;

  return {
    append(samples) {
      if (samples.length >= IQ_BYTES) {
        ring.set(samples.subarray(samples.length - IQ_BYTES));
        position = 0;
        filled = IQ_BYTES;
        return;
      }
      const first = Math.min(samples.length, IQ_BYTES - position);
      ring.set(samples.subarray(0, first), position);
      ring.set(samples.subarray(first));
      position = (position + samples.length) % IQ_BYTES;
      filled = Math.min(IQ_BYTES, filled + samples.length);
    },
    frame(now) {
      if (filled < IQ_BYTES || (lastFrame !== undefined && now - lastFrame < FRAME_INTERVAL_MS)) return null;

      const view = new Uint8Array(memory.buffer, input, IQ_BYTES);
      view.set(ring.subarray(position));
      view.set(ring.subarray(0, position), IQ_BYTES - position);
      const ptr = fft.fft_ptr(input, IQ_BYTES);
      const power = new Float32Array(memory.buffer, ptr, ANALYSIS_SIZE);
      // Start with real measurements, including after a retune, then use the browser's time constant.
      const alpha = lastFrame === undefined ? 1 : 1 - 0.4 ** ((now - lastFrame) / FRAME_INTERVAL_MS);
      lastFrame = now;
      for (let i = 0; i < FFT_SIZE; i++) {
        let peak = -Infinity;
        const end = (i + 1) * BINS_PER_OUTPUT_BIN;
        for (let j = i * BINS_PER_OUTPUT_BIN; j < end; j++) {
          const value = alpha === 1 ? power[j] : smoothed[j] + alpha * (power[j] - smoothed[j]);
          smoothed[j] = value;
          if (value > peak) peak = value;
        }
        reduced[i] = peak;
      }
      return fftPacket(reduced);
    },
    reset() {
      position = 0;
      filled = 0;
      lastFrame = undefined;
    },
    close() {
      fft.free();
      free_iq_buffer(input, IQ_BYTES);
    },
  };
}
