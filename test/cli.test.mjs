import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from '../src/cli.mjs';

test('the V4 profile enables HF tuning with a 2.4 MSPS default', () => {
  const profile = ['--device', 'rtl-sdr-v4'];
  const options = parseOptions([...profile, '--frequency', '7100000'], {});
  assert.equal(options.frequency, 7100000);
  assert.equal(options.sampleRate, 2400000);
  assert.equal(options.device.capabilities.deviceType, 'rtlsdr');
  assert.deepEqual(options.device.capabilities.frequencyRange, [500000, 1766000000]);
  assert.throws(() => parseOptions([...profile, '--frequency', '499999'], {}), /Invalid --frequency/);
  assert.throws(() => parseOptions(['--frequency', '7100000'], {}), /Invalid --frequency/);
  assert.equal(parseOptions([], {}).sampleRate, 3200000);
});

test('proxy headers follow the authorized backend origin when the frontend and backend differ', () => {
  const env = {
    BROWSDR_AUTH_ORIGIN: 'https://turn.example/',
    BROWSDR_AUTHORIZATION: 'Bearer test',
    BROWSDR_COOKIE: 'session=test',
  };
  const args = ['--url', 'https://radio.example/sdr/'];
  assert.deepEqual(parseOptions(args, env).headers, {});
  const options = parseOptions([...args, '--backend-url', 'https://turn.example/sdr/'], env);
  assert.deepEqual(options.headers, { Authorization: 'Bearer test', Cookie: 'session=test' });
});
