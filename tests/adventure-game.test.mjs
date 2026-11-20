import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceRun, presentRewards, startRun } from '../lib/adventure-game.mjs';
import { rules } from '../lib/combat.mjs';

const pet = { name: '团子', speciesId: '3-001', species: '亚古兽', stage: 3 };
const roots = [{ speciesId: '1-001', species: '幼体甲', stage: 1 }, { speciesId: '1-002', species: '幼体乙', stage: 1 }];
const copy = (run) => JSON.parse(JSON.stringify(run));
const choose = (run, id = run.options[0].id) => advanceRun(run, 'choose', id);
const win = (run, forms = []) => {
  run.enemy.hp = 1;
  advanceRun(run, 'move', 'attack', forms);
  assert.equal(run.phase, 'reward');
};
const nextRoute = (run) => {
  while (run.phase === 'reward') choose(run);
};

test('root and successor choices use saved forms and preserve pet identity and equipped skills', () => {
  const run = copy(startRun(pet, roots, ['heavy', 'charge']));
  assert.equal(run.phase, 'root');
  assert.deepEqual(run.options.map(({ id }) => id), roots.map(({ speciesId }) => speciesId));
  choose(run, roots[1].speciesId);
  assert.equal(run.pet.species, '幼体乙');
  assert.equal(run.pet.name, '团子');
  assert.equal(pet.stage, 3);
  assert.deepEqual(run.player.skills, ['heavy', 'charge']);
  assert.equal(startRun(pet, [roots[0]]).pet.stage, 1);
  assert.throws(() => startRun(pet, [], ['revive', 'revive']));
});

test('intent predicts the actual response; rejected moves are atomic and mid-battle resume is deterministic', () => {
  const run = copy(startRun(pet, []));
  assert.match(run.intent, new RegExp(rules.skills[run.intentMove].name));
  const saved = copy(run);
  assert.throws(() => advanceRun(run, 'move', 'heal'), { status: 400 });
  assert.deepEqual(run, saved);
  advanceRun(run, 'move', 'break');
  advanceRun(saved, 'move', 'break');
  assert.deepEqual(run, saved);
  assert.equal(run.player.cooldowns.break, 1);
  assert.match(run.log.at(-1), /使用普攻/);
  assert.match(run.intent, /破甲/);
  const after = copy(run);
  assert.throws(() => advanceRun(run, 'move', 'break'), { status: 409, message: /冷却/ });
  assert.deepEqual(run, after);
});

test('adventure starts with PvP point allocation and records both actions in playback order', () => {
  const points = { attack: 4, defense: 0, vitality: 2 };
  const run = startRun(pet, [], ['counter', 'heal'], points);
  assert.deepEqual(run.player.points, points);
  assert.throws(() => startRun(pet, [], undefined, { ...points, attack: 5 }), { status: 400 });
  const hpBefore = [run.player.hp, run.enemy.hp];
  advanceRun(run, 'move', 'counter');
  const [own, enemy] = run.lastActions;
  assert.deepEqual([own.actor, enemy.actor], [0, 1]);
  assert.deepEqual(own.hpBefore, hpBefore);
  assert.deepEqual(enemy.hpBefore, own.hpAfter);
  assert.ok(enemy.damage > 0 && enemy.counter > 0);
  assert.deepEqual(enemy.hpAfter, [run.player.hp, run.enemy.hp]);
  win(run);
  assert.equal(run.lastActions.length, 1);
  choose(run);
  assert.deepEqual(run.lastActions, []);
});

test('carapace and vampire report only the effective damage prevented and healing gained', () => {
  const baseline = startRun(pet, [], ['heal', 'shield']);
  baseline.enemy.points.attack = 20;
  const boosted = copy(baseline);
  Object.assign(boosted.upgrades, { carapace: 1, vampire: 3 });
  boosted.player.points.defense += 2;
  boosted.player.hp -= 1;

  advanceRun(baseline, 'move', 'attack');
  advanceRun(boosted, 'move', 'attack');
  const [own, enemy] = boosted.lastActions;
  assert.equal(own.vampireHealing, 1);
  assert.equal(own.healing, 1);
  assert.equal(enemy.carapacePrevented, baseline.lastActions[1].damage - enemy.damage);
  assert.equal(enemy.carapacePrevented, 2);
  assert.match(boosted.log.at(-2), /汲血尖牙回复 1 点/);
  assert.match(boosted.log.at(-1), /甲片增厚减少 2 点伤害/);
  assert.ok(baseline.lastActions.every(action => !('vampireHealing' in action) && !('carapacePrevented' in action)));

  const healthy = startRun(pet, [], ['heal', 'shield']);
  Object.assign(healthy.upgrades, { carapace: 3, vampire: 1 });
  healthy.player.points.defense += 6;
  healthy.enemy.base.attack = 0;
  advanceRun(healthy, 'move', 'attack');
  assert.ok(healthy.lastActions[0].damage > 0);
  assert.equal(healthy.lastActions[0].vampireHealing, undefined);
  assert.equal(healthy.lastActions[1].carapacePrevented, undefined);
  healthy.player.hp = 12;
  advanceRun(healthy, 'move', 'heal');
  assert.equal(healthy.lastActions[0].healing, 8);
  assert.equal(healthy.lastActions[0].vampireHealing, undefined);
});

test('only boss floors offer a fork; extra elite victory offers one reward and leaves the boss uncleared', () => {
  const run = startRun(pet, []);
  assert.match(run.catalogNotice, /图鉴/);
  run.player.hp = 10;
  for (let floor = 1; floor <= 4; floor++) {
    win(run);
    assert.equal(run.cleared, floor);
    assert.equal(new Set(run.options.map(({ id }) => id)).size, 3);
    assert.deepEqual(copy(run).options, run.options);
    assert.ok(run.options.every((entry) => entry.description.includes('配合')));
    choose(run);
    assert.equal(run.phase, floor === 4 ? 'route' : 'battle');
  }
  const hp = run.player.hp;
  const rested = copy(run);
  choose(rested, 'rest');
  assert.equal(rested.player.hp, Math.min(rested.player.maxHp, hp + Math.ceil(rested.player.maxHp / 4)));
  assert.equal(rested.enemy.boss, true);
  choose(run, 'elite');
  assert.equal(run.player.hp, hp);
  assert.equal(run.enemy.elite, true);
  assert.equal(run.enemy.boss, false);
  win(run);
  assert.equal(run.cleared, 4);
  assert.equal(run.lastBoss, null);
  choose(run);
  assert.equal(run.enemy.boss, true);
  assert.equal(run.floor, 5);
  assert.throws(() => choose(run, 'elite'));
  win(run);
  assert.equal(run.cleared, 5);
});

test('five-floor boss cycle repeats, evolution preserves build, final forms can repeatedly specialize', () => {
  let run = startRun(pet, [roots[0]], ['charge', 'heavy']);
  const seen = new Set();
  for (let floor = 1; floor <= 20; floor++) {
    assert.equal(run.floor, floor);
    assert.equal(run.enemy.boss, floor % 5 === 0);
    if (run.enemy.boss) seen.add(run.enemy.id);
    win(run, floor === 5 ? [pet] : []);
    nextRoute(run);
    if (floor % 5 === 0) {
      assert.ok(seen.has(run.lastBoss));
      assert.equal(run.phase, 'evolve');
      const saved = copy(run);
      if (floor === 5) {
        choose(saved, pet.speciesId);
        assert.deepEqual(saved.player.skills, ['charge', 'heavy']);
        assert.equal(saved.player.innateSkill.name, '小型火焰');
        assert.deepEqual(saved.upgrades, run.upgrades);
      } else {
        assert.deepEqual(saved.options.map(({ id }) => id), ['burst', 'sustain']);
        const specialization = floor === 15 ? 'burst' : 'sustain';
        choose(saved, specialization);
        assert.equal(saved.specialization, specialization);
      }
      run = saved;
    }
    if (run.phase === 'route') choose(run, 'rest');
  }
  assert.equal(seen.size, 2);
  assert.equal(run.specialization, 'sustain');
  assert.equal(run.floor, 21);
});

test('burst and sustain change different innate outcomes and apply only once', () => {
  for (const speciesId of ['3-001', '3-056']) {
    const run = startRun({ ...pet, speciesId }, []);
    run.player.hp -= 12;
    const burst = copy(run);
    const sustain = copy(run);
    burst.specialization = 'burst';
    sustain.specialization = 'sustain';
    for (const state of [run, burst, sustain]) advanceRun(state, 'move', state.player.innateSkill.id);
    if (speciesId === '3-001') assert.equal(burst.enemy.hp, run.enemy.hp - 5);
    else assert.equal(burst.player.energy, run.player.energy + 2);
    assert.equal(sustain.player.hp, run.player.hp + 5);
  }
});

test('every reinforcement is selectable at its cap without adding stats or ranks', (t) => {
  const random = t.mock.method(Math, 'random');
  const seen = new Set();
  for (let index = 0; index < 12; index++) {
    random.mock.mockImplementation(() => (index + 0.1) / 12);
    const run = startRun(pet, []);
    const scout = copy(run);
    win(scout);
    const id = scout.options[0].id;
    seen.add(id);
    run.upgrades[id] = 3;
    win(run);
    assert.match(run.options[0].description, /满阶/);
    const [choice] = presentRewards(copy(run));
    assert.equal(choice.id, id);
    assert.deepEqual(choice.reward, { effect: '立即回复 12 点生命。', note: '', level: 3, maxRank: 3, capped: true });
    assert.equal(run.options[0].reward, undefined);
    run.player.hp = 1;
    const before = { ...run.player.points };
    choose(run, id);
    assert.deepEqual(run.player.points, before);
    assert.equal(run.upgrades[id], 3);
    assert.equal(run.player.hp, 13);
  }
  assert.equal(seen.size, 12);
});

test('adventure can end immediately, revive can only resolve a fallen pet once per encounter', () => {
  const run = startRun(pet, [], ['heal', 'revive']);
  assert.throws(() => advanceRun(run, 'move', 'revive'), /倒下/);
  run.player.hp = 1;
  advanceRun(run, 'move', 'attack');
  assert.equal(run.player.hp, 0);
  assert.match(run.intent, /复活/);
  assert.throws(() => advanceRun(run, 'move', 'attack'), /复活/);
  const declined = copy(run);
  advanceRun(declined, 'move', 'decline');
  assert.equal(declined.phase, 'ended');
  assert.match(declined.log.at(-1), /放弃复活/);
  advanceRun(run, 'move', 'revive');
  assert.equal(run.player.reviveUsed, true);
  run.player.hp = 1;
  advanceRun(run, 'move', 'attack');
  assert.equal(run.phase, 'ended');
  assert.equal(run.cleared, 0);
  assert.throws(() => advanceRun(run, 'end'));
  const abandoned = startRun(pet, roots);
  advanceRun(abandoned, 'end');
  assert.equal(abandoned.phase, 'ended');
});
