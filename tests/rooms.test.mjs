import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPet, createRooms } from '../lib/rooms.mjs';

const pet = { name: '星光', species: '1-1', stage: 1 };
const points = { attack: 2, defense: 2, vitality: 2 };

test('pet appearance and attribute survive validation while unsafe values are dropped', () => {
  const clean = cleanPet({ ...pet, sprite: 'Chaosdramon', attribute: 'virus' });
  assert.equal(clean.sprite, 'Chaosdramon');
  assert.equal(clean.attribute, 'virus');
  const unsafe = cleanPet({ ...pet, sprite: '../etc/passwd', attribute: 'fire' });
  assert.equal(unsafe.sprite, undefined);
  assert.equal(unsafe.attribute, undefined);
});

function pair(rooms) {
  const { key: host, room: { code } } = rooms('create', { pet });
  const { key: guest } = rooms('join', { code: code.toLowerCase(), pet: { ...pet, name: '月光' } });
  const act = (key, action, extra) => rooms(action, { code, key, ...extra }).room;
  return { act, host, guest };
}

function start(act, host, guest, hostSkills = ['break', 'shield'], guestSkills = ['break', 'shield']) {
  act(host, 'ready', { points, skills: hostSkills });
  assert.equal(act(guest, 'ready', { points, skills: guestSkills }).phase, 'playing');
}

test('equal base budgets, strict loadout validation, visible builds, and locked readiness', () => {
  const { act, host, guest } = pair(createRooms());
  const original = act(host, 'status').players[0];
  assert.equal(Object.values(original.base).reduce((a, b) => a + b), 12);
  for (const draft of [
    { points: { ...points, attack: 3 }, skills: ['heal', 'shield'] },
    { points: { attack: -1, defense: 4, vitality: 3 }, skills: ['heal', 'shield'] },
    { points, skills: ['heal', 'heal'] },
    { points, skills: ['attack', 'shield'] },
  ]) assert.throws(() => act(host, 'loadout', draft), { status: 400 });
  const build = { points: { attack: 0, defense: 0, vitality: 6 }, skills: ['heal', 'shield'] };
  act(host, 'loadout', build);
  const own = act(guest, 'status').players[0];
  assert.deepEqual(own.points, build.points);
  assert.deepEqual(own.skills, build.skills);
  assert.equal(own.maxHp, original.maxHp + 12);
  act(host, 'ready', build);
  assert.equal(act(host, 'ready', build).players[0].ready, true);
  assert.throws(() => act(host, 'loadout', build), { status: 409 });
  assert.equal(act(guest, 'ready').phase, 'playing');
});

test('moves are secret until settlement and energy, cooldowns and status effects are enforced', () => {
  const { act, host, guest } = pair(createRooms());
  start(act, host, guest, ['charge', 'heavy'], ['break', 'shield']);
  assert.throws(() => act('unknown', 'status'), { status: 403 });
  assert.throws(() => act(host, 'move', { round: 1, move: 'heavy' }), /能量不足/);
  assert.throws(() => act(host, 'move', { round: 1, move: 'shield' }), /未装备/);
  act(host, 'move', { round: 1, move: 'charge' });
  const waiting = act(guest, 'status');
  assert.equal(waiting.players[0].locked, true);
  assert.equal(waiting.players[0].move, undefined);
  assert.equal(waiting.players[0].charged, false);
  assert.equal(waiting.players[0].energy, 2);
  assert.throws(() => act(host, 'move', { round: 1, move: 'attack' }), /已锁定/);
  const second = act(guest, 'move', { round: 1, move: 'break' });
  assert.equal(second.players[0].energy, 5);
  assert.equal(second.players[0].charged, true);
  assert.equal(second.players[0].exposed, true);
  assert.match(second.log[0], /蓄力.*破甲/);
  assert.throws(() => act(guest, 'move', { round: 2, move: 'break' }), /冷却/);
  act(host, 'move', { round: 2, move: 'heavy' });
  const third = act(guest, 'move', { round: 2, move: 'shield' });
  assert.equal(third.players[0].energy, 2);
  assert.equal(third.players[0].cooldowns.heavy, 2);
  assert.equal(third.players[0].charged, false);
  assert.equal(third.players[0].exposed, false);
  assert.ok(third.players[1].hp < third.players[1].maxHp);
});

test('counter and healing resolve simultaneously with attack damage', () => {
  const { act, host, guest } = pair(createRooms());
  start(act, host, guest, ['counter', 'heal']);
  act(host, 'move', { round: 1, move: 'counter' });
  const afterCounter = act(guest, 'move', { round: 1, move: 'attack' });
  assert.ok(afterCounter.players.every((player) => player.hp < player.maxHp));
  act(host, 'move', { round: 2, move: 'attack' });
  const beforeHeal = act(guest, 'move', { round: 2, move: 'shield' });
  act(host, 'move', { round: 3, move: 'heal' });
  const afterHeal = act(guest, 'move', { round: 3, move: 'attack' });
  assert.match(afterHeal.log.at(-1), /回复 8/);
  assert.ok(afterHeal.players[0].hp <= afterHeal.players[0].maxHp);
  assert.ok(afterHeal.players[0].hp > beforeHeal.players[0].hp - 8);
});

test('simultaneous knockouts produce a draw and clear locked flags', () => {
  const { act, host, guest } = pair(createRooms());
  const build = { points: { attack: 6, defense: 0, vitality: 0 }, skills: ['heavy', 'break'] };
  act(host, 'ready', build);
  act(guest, 'ready', build);
  for (const [index, move] of ['attack', 'heavy', 'attack', 'attack', 'attack'].entries()) {
    const fields = { round: index + 1, move };
    act(host, 'move', fields);
    if (act(guest, 'move', fields).phase === 'finished') break;
  }
  const done = act(host, 'status');
  assert.equal(done.winner, 'draw');
  assert.deepEqual(done.players.map(({ hp, locked }) => [hp, locked]), [[0, false], [0, false]]);
});

test('timeouts reject stale moves and forfeiting resolves the match', () => {
  let now = 0;
  const { act, host, guest } = pair(createRooms({ clock: () => now, roundMs: 100 }));
  start(act, host, guest);
  act(guest, 'move', { round: 1, move: 'shield' });
  now = 100;
  assert.throws(() => act(host, 'move', { round: 1, move: 'attack' }), { status: 409 });
  const fighter = act(host, 'status').players[0];
  assert.equal(fighter.hp, fighter.maxHp - 5);
  act(host, 'leave');
  assert.equal(act(guest, 'status').winner, 1);
});

test('round limit compares remaining health percentages, including an equal full-health match', () => {
  let now = 0;
  const { act, host, guest } = pair(createRooms({ clock: () => now, roundMs: 100 }));
  act(host, 'ready', { points: { attack: 0, defense: 0, vitality: 6 }, skills: ['heal', 'shield'] });
  act(guest, 'ready');
  for (let round = 1; round <= 12; round += 1) {
    now += 100;
    const room = act(host, 'status');
    assert.equal(room.phase, round === 12 ? 'finished' : 'playing');
  }
  const finished = act(guest, 'status');
  assert.notEqual(finished.players[0].hp, finished.players[1].hp);
  assert.equal(finished.winner, 'draw');
});

test('pending rooms expire even when the host polls, and join retries keep their seat', () => {
  let now = 0;
  const rooms = createRooms({ clock: () => now, maxRooms: 1 });
  const { key: host, room: { code } } = rooms('create', { pet });
  const key = 'x'.repeat(32);
  assert.equal(rooms('join', { code, key, pet }).room.you, 1);
  assert.equal(rooms('join', { code, key, pet }).room.you, 1);
  assert.throws(() => rooms('join', { code, pet }), { status: 409 });
  now = 599_999;
  assert.equal(rooms('status', { code, key: host }).room.phase, 'waiting');
  now += 1;
  assert.throws(() => rooms('status', { code, key: host }), { status: 404 });
  assert.equal(rooms('create', { pet }).room.phase, 'waiting');
});
