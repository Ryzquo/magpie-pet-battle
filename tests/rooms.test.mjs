import assert from 'node:assert/strict';
import test from 'node:test';
import { createRooms } from '../lib/rooms.mjs';

const pet = { name: '星光', species: '1-1', stage: 1 };

function pair(rooms) {
  const { key: host, room: { code } } = rooms('create', { pet });
  const { key: guest } = rooms('join', { code: code.toLowerCase(), pet: { ...pet, name: '月光' } });
  const act = (key, action, extra) => rooms(action, { code, key, ...extra }).room;
  act(host, 'ready');
  assert.equal(act(guest, 'ready').phase, 'playing');
  return { act, host, guest };
}

test('moves remain secret until settlement and best available health wins', () => {
  const { act, host, guest } = pair(createRooms());
  assert.throws(() => act('unknown', 'status'), { status: 403 });
  for (let round = 1; round <= 3; round += 1) {
    act(host, 'move', { round, move: 'strike' });
    const waiting = act(guest, 'status');
    assert.equal(waiting.players[0].locked, true);
    assert.equal(waiting.players[0].move, undefined);
    assert.throws(() => act(host, 'move', { round, move: 'focus' }), { status: 409 });
    act(guest, 'move', { round, move: 'focus' });
  }
  const result = act(host, 'status');
  assert.equal(result.phase, 'finished');
  assert.equal(result.winner, 0);
  assert.deepEqual(result.players.map(({ hp }) => hp), [3, 0]);
});

test('timeout resolves the round, rejects stale moves, and permits forfeiting', () => {
  let now = 0;
  const { act, host, guest } = pair(createRooms({ clock: () => now, roundMs: 100 }));
  act(guest, 'move', { round: 1, move: 'guard' });
  now = 100;
  assert.throws(() => act(host, 'move', { round: 1, move: 'strike' }), { status: 409 });
  assert.equal(act(host, 'status').players[0].hp, 2);
  act(host, 'leave');
  assert.equal(act(guest, 'status').winner, 1);
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
