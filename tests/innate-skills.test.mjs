import assert from 'node:assert/strict';
import test from 'node:test';
import { initialBuild, resetFighter, resolveMoves } from '../lib/combat.mjs';
import { createRooms } from '../lib/rooms.mjs';

function pet(speciesId) {
  return { speciesId, species: `物种${speciesId}`, name: '星星', stage: 1, combatStats: { strength: 50, evasion: 50 } };
}

test('species grants a separate move that is validated and cooled down by the room', () => {
  const hostPet = pet('1-001');
  const guestPet = pet('1-002');
  const rooms = createRooms();
  const { room: { code }, key: host } = rooms('create', { pet: hostPet });
  const { room, key: guest } = rooms('join', { code, pet: guestPet });
  const { innateSkill, points, skills } = room.players[0];
  assert.deepEqual(initialBuild({ ...hostPet, name: '更名' }).innateSkill, innateSkill);
  assert.notEqual(innateSkill.name, room.players[1].innateSkill.name);
  assert.deepEqual(skills, ['break', 'shield']);
  assert.throws(() => rooms('loadout', { code, key: host, points, skills: ['break', innateSkill.id] }), { status: 400 });
  for (const key of [host, guest]) rooms('ready', { code, key });
  const move = (key, round, move) => rooms('move', { code, key, round, move }).room;
  assert.throws(() => move(guest, 1, innateSkill.id), { status: 400 });
  move(host, 1, innateSkill.id);
  const after = move(guest, 1, 'attack');
  assert.equal(after.lastRound.actions[0].name, innateSkill.name);
  assert.ok(after.rules.skills[innateSkill.id].name);
  assert.equal(after.players[0].energy, 0);
  assert.throws(() => move(host, 2, innateSkill.id), /冷却/);
  for (const round of [2, 3]) {
    move(host, round, 'attack');
    move(guest, round, round === 2 ? 'shield' : 'attack');
  }
  assert.equal(move(host, 4, innateSkill.id).players[0].locked, true);
});

test('installed catalog IDs grant named moves regardless of localized species labels', () => {
  for (const [speciesId, id, name, effect] of [
    ['3-001', 'flare', '小型火焰'],
    ['3-008', 'flare', '魔法火焰', 'magic-flame'],
    ['3-022', 'flare', '爆炎火焰弹', 'blue-flame'],
    ['3-029', 'tide', '鱼群大暴走'],
    ['3-056', 'aegis', '毒蔓护壁', 'ivy'],
    ['3-058', 'flare', '空气炮', 'gust'],
    ['3-073', 'flare', '飞翼闪电', 'spark'],
  ]) {
    const { innateSkill } = initialBuild({ ...pet(speciesId), species: '本地化名称' });
    assert.equal(innateSkill.id, id);
    assert.equal(innateSkill.name, name);
    assert.equal(innateSkill.effect, effect);
    const { actions } = duel(speciesId, true);
    assert.equal(actions[0].name, name);
    assert.equal(actions[0].effect, effect);
  }
  assert.equal(initialBuild({ species: '3-001' }).innateSkill.name, '小型火焰');
  assert.equal(initialBuild(pet('1-002')).innateSkill.name, '物种1-002·燎原爪');
});

function duel(speciesId, useInnate) {
  const players = [pet(speciesId), pet('1-002')].map((pet) => ({ pet, ...initialBuild(pet) }));
  players.forEach(resetFighter);
  players[0].move = useInnate ? players[0].innateSkill.id : 'attack';
  players[1].move = 'attack';
  const { actions } = resolveMoves(players, 1);
  return { actions, players };
}

test('flare adds damage, tide heals from its hit, and aegis guards and charges', () => {
  const ordinary = duel('1-002', false).actions[1].damage;
  const flare = duel('1-002', true).actions;
  assert.equal(flare[1].damage, ordinary + 4);
  const tide = duel('1-003', true).actions;
  assert.equal(tide[0].healing, Math.min(4, Math.ceil(tide[1].damage / 2)));
  assert.equal(tide[1].damage, ordinary);
  const aegis = duel('1-001', true);
  assert.equal(aegis.actions[0].damage, Math.round(ordinary / 4));
  assert.equal(aegis.actions[1].damage, 0);
  assert.equal(aegis.players[0].charged, true);
  aegis.players[0].move = 'attack';
  assert.equal(resolveMoves(aegis.players, 2).actions[1].damage, ordinary + 3);
});
