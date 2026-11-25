import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

const CODE_PATTERN = /^[0-9a-f]{20}$/;
const TOKEN_PATTERN = /^[\w-]{20,80}$/;

export function newIdentity() {
  return {
    code: randomBytes(10).toString('hex'),
    token: randomBytes(24).toString('base64url'),
  };
}

export async function loadIdentity(path) {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    if (CODE_PATTERN.test(stored.code) && TOKEN_PATTERN.test(stored.token)) return stored;
    // Rotate short legacy codes on the first start after upgrading.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return newIdentity();
}

export async function saveIdentity(path, identity) {
  // Keep the previous registration intact if the process exits during a write.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(identity) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
