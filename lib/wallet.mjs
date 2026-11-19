import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openWallet(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS settlements (
      match_id TEXT NOT NULL, seat INTEGER NOT NULL CHECK (seat IN (0, 1)),
      wallet_id TEXT NOT NULL REFERENCES wallets(id), result_points INTEGER NOT NULL,
      timeouts INTEGER NOT NULL, forfeited INTEGER NOT NULL, applied INTEGER NOT NULL,
      balance INTEGER NOT NULL CHECK (balance >= 0), PRIMARY KEY (match_id, seat), UNIQUE (match_id, wallet_id)
    ) STRICT;
  `);
  const register = db.prepare('INSERT INTO wallets(id) VALUES (?) ON CONFLICT(id) DO NOTHING');
  const lookup = db.prepare('SELECT balance FROM wallets WHERE id = ?');
  const update = db.prepare('UPDATE wallets SET balance = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const receipts = db.prepare(`SELECT wallet_id AS walletId, result_points AS resultPoints, timeouts, forfeited,
    result_points - timeouts AS total, applied, balance FROM settlements WHERE match_id = ? ORDER BY seat`);

  function identity(walletKey) {
    if (typeof walletKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(walletKey) ||
        Buffer.from(walletKey, 'base64url').toString('base64url') !== walletKey) {
      return null;
    }
    const id = createHash('sha256').update(walletKey).digest('hex');
    register.run(id);
    return id;
  }

  function settle(matchId, seats) {
    if (typeof matchId !== 'string' || !matchId || !Array.isArray(seats) || seats.length !== 2) {
      throw new Error('Expected a match ID and two seats');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved = receipts.all(matchId);
      const result = Array.from(seats, ({ walletId, resultPoints, timeouts, forfeited }, seat) => {
        if (!Number.isSafeInteger(resultPoints) || !Number.isSafeInteger(timeouts) || timeouts < 0 ||
            typeof forfeited !== 'boolean') throw new Error('Invalid match settlement');
        if (saved.length) {
          const row = saved[seat];
          if (!row || row.walletId !== walletId || row.resultPoints !== resultPoints || row.timeouts !== timeouts ||
              Boolean(row.forfeited) !== forfeited) throw new Error('Conflicting match settlement');
          return { resultPoints, timeouts, forfeited, total: row.total, applied: row.applied, balance: row.balance };
        }
        const wallet = lookup.get(walletId);
        if (!wallet) throw new Error('Unknown wallet');
        const total = resultPoints - timeouts;
        const balance = Math.max(0, wallet.balance + total);
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(balance)) throw new Error('Invalid token amount');
        const applied = balance - wallet.balance;
        update.run(balance, walletId);
        insert.run(matchId, seat, walletId, resultPoints, timeouts, Number(forfeited), applied, balance);
        return { resultPoints, timeouts, forfeited, total, applied, balance };
      });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { identity, settle, close: () => db.close() };
}
