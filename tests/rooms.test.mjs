import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPet, createRooms } from '../lib/rooms.mjs';

const pet = { name: '星光', species: '数码兽', speciesId: '3-001', stage: 1, combatStats: { strength: 50, evasion: 50 } };
const points = { attack: 2, defense: 2, vitality: 2 };
const wallet = {
  identity: (key) => ['host', 'guest'].includes(key) ? `account-${key}` : null,
  settle: (_matchId, rows) => rows.map(({ walletId, resultPoints, timeouts, forfeited }) => {
    const total = resultPoints - timeouts;
    return { resultPoints, timeouts, forfeited, total, applied: total, balance: 10 + total };
  }),
};

function pair(options = {}) {
  let now = 1_000;
  const rooms = createRooms({ wallet, chooseFirst: () => 0, clock: () => now, ...options });
  const { key: host, room: { code } } = rooms('create', { pet, walletKey: 'host' });
  const { key: guest } = rooms('join', { code: code.toLowerCase(), walletKey: 'guest', pet: { ...pet, name: '月光' } });
  const act = (seat, action, fields = {}) => rooms(action, { key: [host, guest][seat], code, ...fields }).room;
  const status = () => act(0, 'status');
  const move = (move, room = status()) => act(room.activeSeat, 'move', { turn: room.turn, move, requestId: `move-${room.turn}` });
  function start(left = {}, right = {}) {
    act(0, 'ready', left);
    return act(1, 'ready', right);
  }
  return { act, move, start, status, advance: (ms) => { now += ms; } };
}

const equipment = (...skills) => ({ points, skills });

test('pet metadata and loadout validation preserve the catalog budget and lock ready seats', () => {
  assert.equal(cleanPet({ ...pet, attribute: 'virus' }).attribute, 'virus');
  assert.equal(cleanPet({ ...pet, attribute: 'fire' }).attribute, undefined);
  assert.equal(cleanPet({ ...pet, combatStats: { strength: 101, evasion: 50 } }).combatStats, undefined);
  const { status, act } = pair();
  assert.deepEqual(status().players[0].pet.combatStats, pet.combatStats);
  assert.equal(Object.values(status().players[0].base).reduce((a, b) => a + b), 12);
  for (const build of [equipment('attack', 'heal'), equipment('revive', 'revive'), equipment('constructor', 'heal'),
    { points: { ...points, attack: 3 }, skills: ['heal', 'shield'] }]) {
    assert.throws(() => act(0, 'loadout', build), { status: 400 });
  }
  const build = { points: { attack: 0, defense: 0, vitality: 6 }, skills: ['heal', 'revive'] };
  const before = status().players[0];
  act(0, 'loadout', build);
  assert.equal(act(1, 'status').players[0].maxHp, before.maxHp + 12);
  act(0, 'ready');
  assert.throws(() => act(0, 'loadout', build), { status: 409 });
  assert.equal(act(1, 'ready').phase, 'playing');
});

test('wallet identity is required, private, and distinct for each seat; guest joins retry safely', () => {
  const rooms = createRooms({ wallet });
  assert.throws(() => rooms('create', { pet }), { status: 403 });
  const { room: { code } } = rooms('create', { pet, walletKey: 'host' });
  assert.throws(() => rooms('join', { code, pet, walletKey: 'host' }), { status: 409 });
  const fields = { code, pet, key: 'x'.repeat(32), walletKey: 'guest' };
  const joined = rooms('join', fields);
  assert.deepEqual(rooms('join', fields), joined);
  assert.throws(() => rooms('join', { ...fields, walletKey: 'host' }), { status: 409 });
  assert.doesNotMatch(JSON.stringify(joined.room), /account-|walletKey|walletId/);
  assert.throws(() => rooms('status', { code, key: 'invalid' }), { status: 403 });
});

test('either seat can open; confirmations resolve immediately and identical retries return the current view', () => {
  for (const first of [0, 1]) {
    const { start, act, move } = pair({ chooseFirst: () => first });
    const opening = start();
    assert.equal(opening.firstSeat, first);
    assert.equal(opening.activeSeat, first);
    assert.equal(opening.deadline, 61_000);
    const fields = { turn: 1, move: 'attack', requestId: 'opening' };
    assert.throws(() => act(1 - first, 'move', fields), { status: 409 });
    assert.throws(() => act(first, 'move', { ...fields, requestId: '' }), { status: 400 });
    const next = act(first, 'move', fields);
    assert.equal(next.turn, 2);
    assert.equal(next.activeSeat, 1 - first);
    assert.equal(next.lastAction.actor, first);
    assert.equal(next.lastAction.hpAfter[1 - first], next.lastAction.hpBefore[1 - first] - next.lastAction.damage);
    assert.deepEqual(act(1 - first, 'status').lastAction, next.lastAction);
    const third = move('shield');
    assert.deepEqual(act(first, 'move', fields), { ...third, you: first });
    assert.throws(() => act(first, 'move', { ...fields, move: 'break' }), { status: 409 });
    assert.throws(() => act(first, 'move', { ...fields, requestId: 'late' }), { status: 409 });
  }
});

test('timeouts catch up against deadlines, consume actions and advance only actor cooldowns', () => {
  const { start, move, advance, act, status } = pair();
  start(equipment('heavy', 'charge'), equipment('break', 'shield'));
  assert.throws(() => move('heavy'), /体力不足/);
  assert.throws(() => move('shield'), /未装备/);
  move('charge');
  move('break');
  assert.equal(status().players[0].exposed, true);
  assert.equal(status().players[0].cooldowns.charge, 1);
  advance(120_000);
  assert.throws(() => act(0, 'move', { turn: 3, move: 'attack', requestId: 'late' }), { status: 409 });
  const room = status();
  assert.equal(room.turn, 5);
  assert.equal(room.lastAction.penalty, 5);
  assert.equal(room.lastAction.actor, 1);
  assert.deepEqual(room.players.map((p) => p.actionsUsed), [2, 2]);
  assert.deepEqual(room.players.map((p) => p.cooldowns), [{}, {}]);
  assert.equal(room.players[0].exposed, false);
  assert.equal(room.players[0].charged, true);
  assert.equal(move('heavy').players[0].charged, false);
});

const mutualSequence = [...Array(9).fill('attack'), 'counter', 'attack', 'attack', 'counter', 'attack'];

for (const choice of ['revive', 'decline', 'timeout', 'unequipped']) {
  test(`mutual knockout during counter handles second-seat ${choice}`, () => {
    const { start, move, advance, status, act } = pair();
    start(equipment('counter', 'revive'), equipment('counter', choice === 'unequipped' ? 'heal' : 'revive'));
    let room;
    for (const attack of mutualSequence) room = move(attack);
    assert.deepEqual(room.players.map((p) => p.hp), [0, 0]);
    if (choice === 'unequipped') {
      assert.equal(room.phase, 'finished');
      assert.equal(room.winner, 'draw');
      return;
    }
    assert.equal(room.phase, 'playing');
    assert.equal(room.activeSeat, 1);
    assert.equal(room.revivePending, true);
    assert.equal(room.settlement, null);
    advance(59_999);
    assert.throws(() => move('attack'), /复活/);
    assert.throws(() => act(0, 'move', { turn: room.turn, move: 'revive', requestId: 'wrong-seat' }), { status: 409 });
    if (choice === 'timeout') advance(1);
    room = choice === 'timeout' ? status() : move(choice);
    assert.equal(room.phase, 'finished');
    assert.equal(room.activeSeat, null);
    assert.equal(room.players[1].actionsUsed, 8);
    assert.equal(room.players[1].reviveUsed, choice === 'revive');
    assert.equal(room.players[1].hp, choice === 'revive' ? Math.ceil(room.players[1].maxHp * 0.3) : 0);
    assert.equal(room.settlement[1].timeouts, Number(choice === 'timeout'));
    assert.equal(room.winner, choice === 'revive' ? 1 : 'draw');
  });
}

test('revival costs a turn and cannot be reused after a later knockout', () => {
  const { start, move, status } = pair({ chooseFirst: () => 1 });
  start(equipment('revive', 'charge'), equipment('charge', 'shield'));
  assert.throws(() => move('revive'), { status: 400 });
  let room = status();
  while (!room.revivePending) room = move(room.activeSeat === 1 ? 'attack' : room.turn % 4 === 2 ? 'charge' : 'attack');
  assert.equal(room.activeSeat, 0);
  room = move('revive');
  assert.equal(room.activeSeat, 1);
  assert.equal(room.lastAction.healing, Math.ceil(room.players[0].maxHp * 0.3));
  while (room.phase === 'playing') room = move(room.activeSeat === 1 ? 'attack' : 'charge');
  assert.equal(room.winner, 1);
  assert.equal(room.players[0].reviveUsed, true);
});

test('the 12-action limit compares hp fractions and credits both participants', () => {
  const { start, move } = pair();
  const builds = [0, 6].map((vitality) => ({ points: { attack: 6 - vitality, defense: 0, vitality }, skills: ['charge', 'shield'] }));
  let room = start(...builds);
  while (room.phase === 'playing') {
    const index = room.players[room.activeSeat].actionsUsed;
    room = move(index % 2 ? 'shield' : 'charge');
  }
  assert.equal(room.turn, 24);
  assert.notEqual(room.players[0].hp, room.players[1].hp);
  assert.deepEqual(room.players.map((p) => p.actionsUsed), [12, 12]);
  assert.equal(room.winner, 'draw');
  assert.deepEqual(room.settlement.map((s) => s.total), [1, 1]);
});

function reachFinalActions() {
  const { start, move, advance, status } = pair();
  start(equipment('counter', 'shield'), equipment('revive', 'shield'));
  for (let action = 1; action <= 11; action++) {
    move(action % 2 ? 'shield' : 'counter');
    if ([1, 3, 5].includes(action)) move('shield');
    else { advance(60_000); status(); }
  }
  assert.equal(status().players[1].hp, 2);
  return move;
}

test('the second seat may spend its final action to revive before the HP comparison', () => {
  const move = reachFinalActions();
  const pending = move('attack');
  assert.equal(pending.turn, 24);
  assert.equal(pending.revivePending, true);
  const done = move('revive');
  assert.equal(done.phase, 'finished');
  assert.equal(done.winner, 0);
  assert.deepEqual(done.players.map((p) => p.actionsUsed), [12, 12]);
  assert.equal(done.players[1].hp, Math.ceil(done.players[1].maxHp * 0.3));
});

test('an exhausted second seat cannot revive from a lethal counter on its last action', () => {
  const move = reachFinalActions();
  move('counter');
  const room = move('attack');
  assert.equal(room.phase, 'finished');
  assert.equal(room.players[1].actionsUsed, 12);
  assert.equal(room.players[1].hp, 0);
  assert.equal(room.players[1].reviveUsed, false);
});

test('forfeit and positive rewards depend on a confirmed action; failures retry the same wallet batch', () => {
  const batches = [];
  let fail = true;
  const { start, status, act } = pair({ wallet: { ...wallet, settle(id, rows) {
    batches.push({ id, rows: structuredClone(rows) });
    if (fail) { fail = false; throw new Error('ledger temporarily unavailable'); }
    return wallet.settle(id, rows);
  } } });
  start();
  assert.throws(() => act(1, 'leave'), /ledger temporarily unavailable/);
  const room = status();
  assert.deepEqual(batches[0], batches[1]);
  assert.deepEqual(batches[0].rows.map((r) => r.walletId), ['account-host', 'account-guest']);
  assert.deepEqual(room.settlement.map((s) => s.total), [0, -3]);
  assert.deepEqual(act(1, 'leave', { reviewSettlement: true }).settlement, room.settlement);
  assert.equal(batches.length, 2);
});

test('a failed terminal action receipt can be retried after wallet commit without replaying the hit', () => {
  const ledger = new Map();
  const { start, move, status, act, advance } = pair({ wallet: { ...wallet, settle(id, rows) {
    if (ledger.has(id)) return ledger.get(id);
    ledger.set(id, wallet.settle(id, rows));
    throw new Error('receipt lost');
  } } });
  let room = start();
  while (room.players[1].hp > 7) {
    room = move('attack');
    if (room.phase === 'playing') { advance(60_000); room = status(); }
  }
  const fields = { turn: room.turn, move: 'attack', requestId: 'last' };
  assert.throws(() => act(0, 'move', fields), /receipt lost/);
  const done = act(0, 'move', fields);
  assert.equal(done.phase, 'finished');
  assert.equal(done.winner, 0);
  assert.equal(done.settlement[0].total, 3);
  assert.equal(done.settlement[1].total, -1 - done.settlement[1].timeouts);
  assert.equal(done.lastAction.turn, fields.turn);
  assert.equal(ledger.size, 1);
});

test('waiting rooms expire even when the host polls', () => {
  const { advance, status } = pair();
  advance(599_999);
  assert.equal(status().phase, 'waiting');
  advance(1);
  assert.throws(status, { status: 404 });
});
