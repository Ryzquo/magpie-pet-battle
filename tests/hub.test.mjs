import assert from 'node:assert/strict';
import test from 'node:test';
import { createHub } from '../lib/hub.mjs';

const pet = { name: '星光', species: '1-1', stage: 1 };
const idA = '11111111-1111-1111-1111-111111111111';
const idB = '22222222-2222-2222-2222-222222222222';

test('hub announces online players and relays invites through inboxes', () => {
  let now = 0;
  const hub = createHub({ clock: () => now });
  assert.deepEqual(hub.announce({ id: idA, pet }), { peers: [], invites: [] });
  const second = hub.announce({ id: idB, pet: { ...pet, name: '月光' } });
  assert.deepEqual(second.peers.map(({ id, name }) => [id, name]), [[idA, '星光']]);

  hub.invite({ from: idB, target: idA, code: 'ABCD2345' });
  const invited = hub.announce({ id: idA, pet });
  assert.equal(invited.invites.length, 1);
  assert.deepEqual({
    id: invited.invites[0].id,
    from: invited.invites[0].from,
    name: invited.invites[0].name,
    code: invited.invites[0].code,
  }, { id: `${idB}/ABCD2345`, from: idB, name: '月光', code: 'ABCD2345' });
  assert.deepEqual(hub.announce({ id: idA, pet }).invites, []);
});

test('hub rejects invalid identities, offline targets and bad codes', () => {
  const hub = createHub();
  assert.throws(() => hub.announce({ id: 'not-a-uuid', pet }), { status: 400 });
  assert.throws(() => hub.announce({ id: idA, pet: { name: '' } }), { status: 400 });
  hub.announce({ id: idA, pet });
  assert.throws(() => hub.invite({ from: idA, target: idB, code: 'ABCD2345' }), { status: 404 });
  assert.throws(() => hub.invite({ from: idB, target: idA, code: 'ABCD2345' }), { status: 403 });
  assert.throws(() => hub.invite({ from: idA, target: idA, code: 'bad' }), { status: 400 });
});

test('hub expires silent peers and stale invites', () => {
  let now = 0;
  const hub = createHub({ clock: () => now });
  hub.announce({ id: idA, pet });
  hub.announce({ id: idB, pet });
  hub.invite({ from: idB, target: idA, code: 'ABCD2345' });

  now = 16_001;
  const late = hub.announce({ id: idA, pet });
  assert.deepEqual(late.peers, []);
  assert.equal(late.invites.length, 1);

  now = 60_001;
  assert.deepEqual(hub.announce({ id: idA, pet }).invites, []);
});
