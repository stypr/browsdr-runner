import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_AUDIO_DSP_METHODS } from './host-audio.mjs';

export async function loadDsp(dspDir) {
  // Resolve the bundled checkout relative to the source, independent of the service working directory.
  const entryUrl = dspDir
    ? pathToFileURL(join(dspDir, 'browsdr_dsp.js'))
    : new URL('../../BrowSDR/wasm/dsp/pkg/browsdr_dsp.js', import.meta.url);
  try {
    const { default: init, FFT, DspProcessor, alloc_iq_buffer, free_iq_buffer } = await import(entryUrl.href);
    const methods = [
      [DspProcessor, ['process_iq_only_ptr', 'get_iq_output_len', 'set_if_sample_rate', 'set_bandwidth', 'reset', 'free', ...HOST_AUDIO_DSP_METHODS]],
      [FFT, ['fft_ptr', 'free']],
    ];
    if (methods.some(([constructor, names]) => names.some((name) => typeof constructor?.prototype[name] !== 'function'))) {
      throw new Error('The module does not expose the IQ and host PCM DSP methods.');
    }
    if ([init, alloc_iq_buffer, free_iq_buffer].some((value) => typeof value !== 'function')) {
      throw new Error('The module does not expose the WASM initialization and buffer functions.');
    }
    const wasm = await readFile(new URL('browsdr_dsp_bg.wasm', entryUrl));
    const { memory } = await init({ module_or_path: wasm });
    if (!(memory instanceof WebAssembly.Memory)) throw new Error('The module does not expose WASM memory.');
    return { memory, FFT, DspProcessor, alloc_iq_buffer, free_iq_buffer };
  } catch (error) {
    throw new Error(`BrowSDR DSP at ${entryUrl.pathname} is unavailable or incompatible. Set --dsp-dir to a tested WASM bundle. ${error.message}`, { cause: error });
  }
}
