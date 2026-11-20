import assert from 'node:assert/strict';
import test from 'node:test';
import { selectScenery } from '../page/adventure-scenery.js';
import { startRun } from '../lib/adventure-game.mjs';

const pet = { name: '团子', species: '亚古兽', speciesId: '3-001', stage: 3 };

test('saved encounters keep their scenery through actions, reload and evolution, including older saves', () => {
  const run = startRun(pet);
  assert.notEqual(run.scenerySeed, startRun(pet).scenerySeed);
  for (const snapshot of [run, { ...run, scenerySeed: undefined }]) {
    const restored = JSON.parse(JSON.stringify(snapshot));
    restored.pet.speciesId = '4-055';
    restored.enemy.hp -= 1;
    assert.deepEqual(selectScenery(restored), selectScenery(snapshot));
  }
});

test('five-floor stretches share a biome, with distinct encounters and landmarks at the boss', () => {
  const seed = { scenerySeed: 'test-seed' };
  const scene = (floor, enemy = { id: 'scout' }) => selectScenery({ ...seed, floor, enemy });
  const normal = [1, 2, 3, 4].map((floor) => scene(floor));
  const firstBiome = normal[0].biome;
  assert.ok(normal.every(({ biome }) => biome === firstBiome));
  assert.equal(new Set(normal.map(({ props }) => props.map(({ kind }) => kind).sort().join(','))).size, 4);
  const elite = scene(5, { id: 'guard', elite: true });
  const iron = scene(5, { id: 'iron-king', boss: true });
  const dragon = scene(10, { id: 'ember-dragon', boss: true });
  assert.equal(iron.biome, elite.biome);
  assert.notDeepEqual(iron.props, elite.props);
  assert.equal(iron.landmark, 'ironGate');
  assert.equal(dragon.landmark, 'emberAltar');
  const biomes = [1, 6, 11, 16, 21, 26, 31].map((floor) => scene(floor).biome);
  assert.equal(new Set(biomes.slice(0, 6)).size, 6);
  assert.equal(biomes[0], biomes[6]);
});
