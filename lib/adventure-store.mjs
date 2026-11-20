import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { advanceRun, presentRewards, startRun } from './adventure-game.mjs';
import { ArenaError } from './rooms.mjs';
import { rules } from './combat.mjs';
import { adventureRewards } from './adventure-rewards.mjs';

const empty = () => ({ revision: 0, best: 0, run: null, unlocks: [], equipped: { title: '', effect: '' } });

export async function createAdventureStore({ catalog, path = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  'magpie-pet-battle', 'adventure.sqlite') }) {
  let db;
  const Database = process.versions.bun ? (await import('bun:sqlite')).Database : (await import('node:sqlite')).DatabaseSync;
  function connect() {
    if (!db) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const opened = new Database(path);
      try {
        opened.exec(`PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS adventure_v1 (
          slot INTEGER PRIMARY KEY CHECK(slot=1), state TEXT NOT NULL)`);
        db = opened;
      } catch (error) {
        opened.close();
        throw error;
      }
    }
    return db;
  }
  function view() {
    if (!db && !existsSync(path)) return empty();
    const row = connect().prepare('SELECT state FROM adventure_v1 WHERE slot=1').get();
    return row ? JSON.parse(row.state) : empty();
  }
  function apply(data, getPet) {
    const connection = connect();
    connection.exec('BEGIN IMMEDIATE');
    try {
      const state = view();
      if (data.adventureRevision !== state.revision) throw new ArenaError(409, '进度已更新，请刷新后继续。');
      if (data.action === 'adventure-start') {
        if (state.run && state.run.phase !== 'ended') throw new ArenaError(409, '已有进行中的冒险。');
        const pet = getPet();
        state.run = startRun(pet, catalog.roots(pet.speciesId), data.skills, data.points);
      } else if (data.action === 'adventure-equip') {
        const { kind, value } = data;
        if (!['effect', 'title'].includes(kind) || (value !== '' && !state.unlocks.some((u) => u.kind === kind && u.id === value))) {
          throw new ArenaError(400, '尚未解锁该展示奖励。');
        }
        state.equipped[kind] = value;
      } else {
        const command = { 'adventure-move': 'move', 'adventure-choose': 'choose', 'adventure-end': 'end' }[data.action];
        if (!command || !state.run || state.run.phase === 'ended') throw new ArenaError(409, '当前没有可操作的冒险。');
        advanceRun(state.run, command, data.value, catalog.successors(state.run.pet.speciesId));
        state.best = Math.max(state.best, state.run.cleared);
        for (const { id, name, kind, floor, boss, upgrade } of adventureRewards) {
          const earned = (floor && state.best >= floor) || (boss && state.run.lastBoss === boss) ||
            (upgrade && state.run.upgrades[upgrade] >= 2);
          if (earned && !state.unlocks.some((u) => u.id === id)) state.unlocks.push({ id, name, kind });
        }
      }
      state.revision++;
      connection.prepare('INSERT OR REPLACE INTO adventure_v1(slot,state) VALUES (1,?)').run(JSON.stringify(state));
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  function snapshot() {
    const state = view();
    if (state.run?.phase === 'reward') state.run.options = presentRewards(state.run);
    return { ...state, rules };
  }
  return { apply, view: snapshot, close() { db?.close(); db = undefined; } };
}
