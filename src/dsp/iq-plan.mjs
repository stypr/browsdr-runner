// The IQ v1 client derives its slice revision using these IF and pager rates.
export const IF_RATES = {
  nfm: 50000, wfm: 250000, hdradio: 744187.5, am: 15000, usb: 24000,
  lsb: 24000, dsb: 24000, cw: 3000, raw: 48000, dsd: 48000,
};
const PAGER_RX_BANDWIDTH = { pocsag: 15000, gsc: 12500, flex: 18000 };
const SLICE_RATES = [50000, 100000, 250000, 500000, 1000000, 2000000, 3000000, 4000000, 8000000, 16000000];
const DECODERS = ['pocsag', 'gsc', 'flex', 'rtl433', 'adsb', 'ais', 'radiosonde', 'rtk', 'ble', 'acars', 'aprs'];

export function planSlice(params, radio) {
  const { centerFreq, sampleRate } = radio;
  const { freq, mode } = params;
  if (!params.enabled && mode !== 'hdradio' && !(params.rds && mode === 'wfm') && !DECODERS.some((key) => params[key] === true)) return null;
  if (params.rtk && (params.rtkProfile === 'scan' || params.rtkProfile === 'auto' || params.rtkFollowHops === true)) {
    return { centerFreq, sampleRate, bandwidth: sampleRate, fullBand: true };
  }
  let bandwidth = params.bandwidth * (mode === 'usb' || mode === 'lsb' ? 2 : 1);
  let minimumRate = IF_RATES[mode];
  if (mode === 'wfm' && params.stereo) bandwidth = Math.max(bandwidth, 200000);
  if (mode === 'wfm' && params.rds) bandwidth = Math.max(bandwidth, 250000);
  if (mode === 'hdradio') bandwidth = Math.max(bandwidth, 400000);
  for (const [protocol, width] of Object.entries(PAGER_RX_BANDWIDTH)) {
    if (params[protocol]) bandwidth = Math.max(bandwidth, width);
  }
  if (params.rtl433) {
    const rate = [250000, 500000, 1000000].includes(params.rtl433SampleRate) ? params.rtl433SampleRate : 250000;
    bandwidth = Math.max(bandwidth, rate * 0.8);
    minimumRate = Math.max(minimumRate, rate);
  }
  if (params.adsb || params.ble) bandwidth = Math.max(bandwidth, 2000000);
  if (params.rtk) bandwidth = Math.max(bandwidth, 1000000);
  const narrowDecoder = params.ais || params.acars || params.radiosonde || params.aprs;
  if (narrowDecoder) {
    minimumRate = Math.max(minimumRate, 48000);
    bandwidth = Math.max(bandwidth, params.ais || params.acars ? 25000 : params.radiosonde ? 20000 : 16000);
  }

  // Leave room for the filter transition when choosing a transport sample rate.
  const required = Math.max(minimumRate, bandwidth / 0.8);
  const rate = Math.min(sampleRate, SLICE_RATES.find((value) => value >= required) ?? sampleRate);
  const span = Math.max(bandwidth, narrowDecoder ? 48000 : 0);
  if (span > rate || minimumRate > sampleRate || Math.abs(freq - centerFreq) * 1e6 + span / 2 > sampleRate / 2) return null;
  const half = (sampleRate - rate) / 2e6;
  const center = Math.max(centerFreq - half, Math.min(centerFreq + half, freq));
  if (Math.abs(freq - center) * 1e6 + span / 2 > rate / 2) return null;
  // Keep the transport filter broad for narrow VFOs. The client applies the final channel filter.
  const sliceBandwidth = Math.max(rate / 8, bandwidth + 2e6 * Math.abs(freq - center));
  return { centerFreq: center, sampleRate: rate, bandwidth: Math.min(rate, sliceBandwidth), fullBand: false };
}
