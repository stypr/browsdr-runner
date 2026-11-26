import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from '../src/cli.mjs';

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
