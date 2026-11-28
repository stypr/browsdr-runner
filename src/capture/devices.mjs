const slider = (name, min, max, step, initial) => ({ name, min, max, step, default: initial, type: 'slider' });

const rtlSdr = {
  name: 'RTL-SDR',
  capabilities: {
    deviceType: 'rtlsdr', nativeIqBits: 8, sampleFormat: 'uint8',
    sampleRates: [250000, 1024000, 1536000, 1920000, 2048000, 2160000, 2400000, 2560000, 2880000, 3200000],
    gainControls: [slider('Tuner Gain', 0, 49.6, 0.1, 0)],
    frequencyRange: [24000000, 1766000000],
  },
  defaults: { rate: 3200000, frequency: 99900000 },
  command: 'rtl_tcp',
  args: (frequency, rate, gains, device, host, port) => [
    ...(device ? ['-d', device] : []), '-a', host, '-p', port,
    '-f', frequency, '-s', rate, '-g', gains['Tuner Gain'], '-n', 2,
  ],
};

// Capabilities are advertised to clients and also constrain incoming tuning requests.
export const devices = {
  'rtl-sdr': rtlSdr,
  'rtl-sdr-v4': {
    ...rtlSdr,
    name: 'RTL-SDR Blog V4',
    capabilities: {
      ...rtlSdr.capabilities,
      // librtlsdr handles the built-in HF upconverter on both V4 and V4 Lite.
      frequencyRange: [500000, 1766000000],
    },
    defaults: { ...rtlSdr.defaults, rate: 2400000 },
  },
  hackrf: {
    name: 'HackRF One',
    capabilities: {
      deviceType: 'hackrf', nativeIqBits: 8, sampleFormat: 'int8',
      sampleRates: [2000000, 4000000, 5000000, 8000000, 10000000, 16000000, 20000000],
      gainControls: [slider('LNA', 0, 40, 8, 16), slider('VGA', 0, 62, 2, 16)],
      frequencyRange: [1000000, 6000000000],
    },
    defaults: { rate: 20000000, frequency: 99900000 },
    command: 'hackrf_transfer',
    args: (frequency, rate, gains, device) =>
      [...(device ? ['-d', device] : []), '-r', '-', '-f', frequency, '-s', rate, '-l', gains.LNA, '-g', gains.VGA],
  },
};
