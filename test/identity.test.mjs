import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIdentity, newIdentity, saveIdentity } from '../src/remote/identity.mjs';

test('share identity uses a 20-character random hex code', () => {
  const first = newIdentity();
  const second = newIdentity();
  assert.match(first.code, /^[0-9a-f]{20}$/);
  assert.match(first.token, /^[\w-]{32}$/);
  assert.notEqual(first.code, second.code);
  assert.notEqual(first.token, second.token);
});

test('an existing short share code rotates once and the new code persists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browsdr-identity-'));
  const path = join(directory, 'identity.json');
  try {
    const legacy = { code: 'a1b2c3', token: '12345678901234567890123456789012' };
    await writeFile(path, JSON.stringify(legacy));
    const replacement = await loadIdentity(path);
    assert.match(replacement.code, /^[0-9a-f]{20}$/);
    assert.notEqual(replacement.token, legacy.token);
    await saveIdentity(path, replacement);
    assert.deepEqual(await loadIdentity(path), replacement);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
