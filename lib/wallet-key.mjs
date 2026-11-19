import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function loadWalletKey(relayUrl) {
  const relay = new URL(relayUrl).href.replace(/\/+$/, '');
  const directory = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'magpie-pet-battle', 'wallets');
  const path = join(directory, createHash('sha256').update(relay).digest('hex'));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  async function readKey() {
    const key = (await readFile(path, 'utf8')).trimEnd();
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key) {
      throw new Error('Stored wallet key is invalid');
    }
    await chmod(path, 0o600);
    return key;
  }
  try {
    return await readKey();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Publish a complete key atomically. A concurrent installer reads the winner's key.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(randomBytes(32).toString('base64url'), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return await readKey();
  } finally {
    await unlink(temporary);
  }
}
