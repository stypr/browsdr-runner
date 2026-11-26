// Remote IQ v1 layout matches BrowSDR main at 255ceef490d90733a26baa6c0fde9c2b7d3fb0ef.
export const RECEIVER_ID = 'native-sdr';
export const FFT_SIZE = 2048;
export const AUDIO_RATE = 48000;
export const MAX_IQ_VALUES = 6000;

const receiverPrefix = Buffer.alloc(6 + Buffer.byteLength(RECEIVER_ID));
receiverPrefix.write('BSDR');
receiverPrefix.writeUInt16LE(Buffer.byteLength(RECEIVER_ID), 4);
receiverPrefix.write(RECEIVER_ID, 6);
const IQ_HEADER_SIZE = 48;
export const IQ_OVERHEAD = receiverPrefix.length + IQ_HEADER_SIZE;

export function iqPacket({ index, revision, sequence, plan, discontinuity }, samples, scale) {
  const packet = Buffer.allocUnsafe(IQ_OVERHEAD + samples.length);
  receiverPrefix.copy(packet);
  const offset = receiverPrefix.length;
  packet.write('BSIQ', offset);
  packet[offset + 4] = 1;
  packet[offset + 5] = 8;
  packet[offset + 6] = (discontinuity ? 1 : 0) | (plan.fullBand ? 2 : 0);
  packet[offset + 7] = 0;
  packet.writeUInt32LE(index, offset + 8);
  packet.writeUInt32LE(revision, offset + 12);
  packet.writeUInt32LE(sequence, offset + 16);
  packet.writeUInt32LE(samples.length, offset + 20);
  packet.writeDoubleLE(plan.centerFreq, offset + 24);
  packet.writeDoubleLE(plan.sampleRate, offset + 32);
  packet.writeFloatLE(scale, offset + 40);
  packet.writeFloatLE(plan.bandwidth, offset + 44);
  packet.set(samples, IQ_OVERHEAD);
  return packet;
}

export function fftPacket(power) {
  const frame = Buffer.allocUnsafe(receiverPrefix.length + 4 + power.length);
  receiverPrefix.copy(frame);
  const offset = receiverPrefix.length;
  frame.writeUInt16BE(0xffda, offset);
  frame.writeUInt16LE(power.length, offset + 2);
  for (let i = 0; i < power.length; i++) frame[offset + 4 + i] = Math.max(0, Math.min(255, Math.round(power[i] + 120)));
  return frame;
}

// Legacy BrowSDR uses raw mono Float32. Stereo uses a 16-byte SDR2 header.
export function pcmPacket(samples, channels) {
  const stereoHeaderSize = channels === 2 ? 16 : 0;
  const start = receiverPrefix.length;
  const packet = Buffer.allocUnsafe(start + stereoHeaderSize + samples.length * 4);
  receiverPrefix.copy(packet);
  if (stereoHeaderSize) {
    packet.write('SDR2', start);
    packet.writeUInt32LE(1, start + 4);
    packet.writeUInt32LE(2, start + 8);
    packet.writeUInt32LE(AUDIO_RATE, start + 12);
  }
  for (let i = 0; i < samples.length; i++) {
    packet.writeFloatLE(Math.max(-1, Math.min(1, samples[i])), start + stereoHeaderSize + i * 4);
  }
  return packet;
}
