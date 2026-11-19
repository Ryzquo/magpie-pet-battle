import assert from 'node:assert/strict';
import test from 'node:test';
import { initialBuild, resetFighter, resolveAction } from '../lib/combat.mjs';
import { createRooms } from '../lib/rooms.mjs';

function pet(speciesId) {
  return { speciesId, species: `物种${speciesId}`, name: '星星', stage: 1, combatStats: { strength: 50, evasion: 50 } };
}

function fighters(speciesId = '3-001') {
  return [pet(speciesId), pet('3-001')].map((pet) => {
    const player = { pet, ...initialBuild(pet) };
    resetFighter(player);
    return player;
  });
}

test('species grants a separate move validated and cooled down by the room', () => {
  const rooms = createRooms({ chooseFirst: () => 0, wallet: { identity: (key) => key } });
  const hostPet = pet('1-001');
  const { room: { code }, key: host } = rooms('create', { pet: hostPet, walletKey: 'a' });
  const { room, key: guest } = rooms('join', { code, pet: pet('1-002'), walletKey: 'b' });
  const { innateSkill, points, skills } = room.players[0];
  assert.deepEqual(initialBuild({ ...hostPet, name: '更名' }).innateSkill, innateSkill);
  assert.notEqual(innateSkill.name, room.players[1].innateSkill.name);
  assert.deepEqual(skills, ['break', 'shield']);
  assert.throws(() => rooms('loadout', { code, key: host, points, skills: ['break', innateSkill.id] }), { status: 400 });
  for (const key of [host, guest]) rooms('ready', { code, key });
  const move = (key, turn, move) => rooms('move', { code, key, turn, move, requestId: `hand-${turn}` }).room;
  const after = move(host, 1, innateSkill.id);
  assert.equal(after.lastAction.name, innateSkill.name);
  assert.ok(after.rules.skills[innateSkill.id].name);
  assert.equal(after.players[0].energy, 0);
  assert.throws(() => move(guest, 2, innateSkill.id), { status: 400 });
  move(guest, 2, 'attack');
  assert.throws(() => move(host, 3, innateSkill.id), /冷却/);
  for (const turn of [3, 5]) {
    move(host, turn, 'attack');
    move(guest, turn + 1, turn === 3 ? 'shield' : 'attack');
  }
  assert.equal(move(host, 7, innateSkill.id).lastAction.move, innateSkill.id);
});

test('installed catalog IDs grant named moves and events carry the effect regardless of localization', () => {
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
    const action = resolveAction(fighters(speciesId), 1, 0, id);
    assert.equal(action.name, name);
    assert.equal(action.effect, effect);
  }
  assert.equal(initialBuild({ species: '3-001' }).innateSkill.name, '小型火焰');
  assert.equal(initialBuild(pet('1-002')).innateSkill.name, '物种1-002·燎原爪');
});

test('flare adds damage, tide heals from the hit, and aegis guards the next opposing action', () => {
  const ordinary = resolveAction(fighters(), 1, 0, 'attack').damage;
  assert.equal(resolveAction(fighters(), 1, 0, 'flare').damage, ordinary + 4);
  const singers = fighters('3-029');
  singers[0].hp -= 6;
  const tide = resolveAction(singers, 1, 0, 'tide');
  assert.equal(tide.damage, ordinary);
  assert.equal(tide.healing, Math.min(4, Math.ceil(tide.damage / 2)));
  const guards = fighters('3-056');
  resolveAction(guards, 1, 0, 'aegis');
  assert.equal(resolveAction(guards, 2, 1, 'attack').damage, Math.round(ordinary / 4));
  assert.equal(guards[0].stance, null);
  assert.equal(guards[0].charged, true);
  resolveAction(guards, 3, 0, 'counter');
  const counter = resolveAction(guards, 4, 1, 'attack');
  assert.equal(counter.counter, 6);
  assert.equal(counter.damage, Math.round(ordinary * 2 / 3));
  assert.equal(guards[0].charged, true);
  assert.equal(resolveAction(guards, 5, 0, 'attack').damage, ordinary + 3);
  assert.equal(guards[0].charged, false);
});

test('exposure lasts through the caster’s next action and a non-attack spends the opposing stance', () => {
  const players = fighters();
  resolveAction(players, 1, 0, 'break');
  resolveAction(players, 2, 1, 'shield');
  assert.equal(players[1].exposed, true);
  const strike = resolveAction(players, 3, 0, 'attack');
  assert.equal(strike.damage, 5);
  assert.equal(players[1].exposed, false);
  assert.equal(players[1].stance, null);
  resolveAction(players, 4, 1, 'counter');
  resolveAction(players, 5, 0, 'charge');
  assert.equal(players[1].stance, null);
});
