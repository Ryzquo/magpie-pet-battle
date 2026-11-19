import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { openWallet } from '../lib/wallet.mjs';
import { loadWalletKey } from '../lib/wallet-key.mjs';

const key = () => randomBytes(32).toString('base64url');
const seat = (walletId, resultPoints, timeouts = 0, forfeited = false) => ({ walletId, resultPoints, timeouts, forfeited });

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pet-battle-wallet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('wallet verifies canonical private keys and stores only their digest', async (t) => {
  const path = join(await temporaryDirectory(t), 'data', 'relay.sqlite');
  const wallet = openWallet(path);
  const bearer = key();
  try {
    const id = wallet.identity(bearer);
    assert.equal(wallet.identity(bearer), id);
    assert.notEqual(wallet.identity(key()), id);
    for (const invalid of [null, '', id, 'a'.repeat(43), `${bearer}=`, bearer.slice(0, -1)]) {
      assert.equal(wallet.identity(invalid), null);
    }
  } finally {
    wallet.close();
  }
  assert.equal((await readFile(path)).includes(bearer), false);
});

test('atomic settlements survive restarts and exact retries return their historical balance', async (t) => {
  const path = join(await temporaryDirectory(t), 'wallet.sqlite');
  const bearer = key();
  const first = openWallet(path);
  const a = first.identity(bearer);
  const b = first.identity(key());
  const seats = [seat(a, 3, 1), seat(b, -3, 2, true)];
  const receipt = first.settle('first', seats);
  assert.deepEqual(receipt, [
    { resultPoints: 3, timeouts: 1, forfeited: false, total: 2, applied: 2, balance: 2 },
    { resultPoints: -3, timeouts: 2, forfeited: true, total: -5, applied: 0, balance: 0 },
  ]);
  first.close();
  const second = openWallet(path);
  t.after(() => second.close());
  assert.equal(second.identity(bearer), a);
  assert.throws(() => second.settle('next', [seat(a, 3), seat('unknown', 1)]));
  assert.throws(() => second.settle('next', [seat(a, 3), seat(a, 1)]));
  const next = second.settle('next', [seat(a, -3), seat(b, 1)]);
  assert.deepEqual(next.map(({ applied, balance }) => [applied, balance]), [[-2, 0], [1, 1]]);
  assert.deepEqual(second.settle('first', seats), receipt);
  assert.throws(() => second.settle('first', seats.toReversed()), /Conflicting/);
});

test('independent SQLite connections credit a simultaneous match retry once', async (t) => {
  const path = join(await temporaryDirectory(t), 'wallet.sqlite');
  const wallet = openWallet(path);
  t.after(() => wallet.close());
  const seats = [seat(wallet.identity(key()), 3), seat(wallet.identity(key()), 1)];
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { openWallet } from ${JSON.stringify(new URL('../lib/wallet.mjs', import.meta.url).href)};
    const wallet = openWallet(workerData.path);
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
      const receipt = wallet.settle('retry', workerData.seats);
      wallet.close();
      parentPort.postMessage(receipt);
    });
  `;
  const url = new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`);
  const workers = Array.from({ length: 2 }, () => new Worker(url, { workerData: { path, seats } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const replies = workers.map(worker => once(worker, 'message'));
  workers.forEach(worker => worker.postMessage('settle'));
  const [left, right] = await Promise.all(replies);
  assert.deepEqual(left, right);
  assert.deepEqual(wallet.settle('following', seats).map(row => row.balance), [6, 2]);
});

test('concurrent local starts share a private key per relay and preserve malformed files', async (t) => {
  const home = await temporaryDirectory(t);
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  });
  const relay = 'https://relay.example/arena';
  const keys = await Promise.all(Array.from({ length: 24 }, () => loadWalletKey(relay)));
  assert.equal(new Set(keys).size, 1);
  assert.equal(Buffer.from(keys[0], 'base64url').length, 32);
  const directory = join(home, 'magpie-pet-battle', 'wallets');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await loadWalletKey('https://RELAY.example:443/arena/'), keys[0]);
  assert.notEqual(await loadWalletKey('https://relay.example/other'), keys[0]);
  await writeFile(path, 'invalid');
  await assert.rejects(loadWalletKey(relay), /Stored wallet key is invalid/);
  assert.equal(await readFile(path, 'utf8'), 'invalid');
});
