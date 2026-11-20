import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startLocal } from '../lib/local.mjs';
import { cleanPet } from '../lib/rooms.mjs';

const pet = { speciesId: '2-001', name: '旅伴', species: '伙伴', stage: 2 };
const baby = { speciesId: '1-001', species: '幼体', stage: 1 };
const catalog = { roots: () => [baby], successors: () => [pet] };
const storeUrl = new URL('../lib/adventure-store.mjs', import.meta.url).href;

// An independent Node process has neither the page session nor the game's in-memory objects.
function readInFreshProcess(path, action = null) {
  const script = `import { createAdventureStore } from ${JSON.stringify(storeUrl)};
    const store = await createAdventureStore({ path: process.argv[1], catalog: { successors: () => [] } });
    const action = JSON.parse(process.argv[2]);
    if (action) store.apply(action);
    console.log(JSON.stringify(store.view())); store.close();`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, path, JSON.stringify(action)],
    { encoding: 'utf8' }));
}

test('local page API commits fights, choices, cosmetics and ending to one recoverable slot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'adventure-resume-'));
  const path = join(directory, 'save.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let selected = pet;
  const service = await startLocal({ port: 0, relayUrl: 'invalid', adventurePath: path,
    adventureCatalog: catalog, getPet: () => ({ pet: selected }) });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.port}`;
  const html = await (await fetch(base)).text();
  const token = /name="arena-token" content="([^"]+)"/.exec(html)[1];
  const headers = { 'x-arena-token': token, 'content-type': 'application/json' };
  const status = async () => (await (await fetch(`${base}/api/status`, { headers })).json()).adventure;
  let snapshot = await status();
  const post = (body) => fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify(body) });
  async function action(command, fields = {}) {
    const response = await post({ action: `adventure-${command}`, adventureRevision: snapshot.revision, ...fields });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    snapshot = result.adventure;
  }
  const recovered = () => {
    const { hasEvolutionData, ...persisted } = snapshot;
    assert.deepEqual(readInFreshProcess(path), persisted);
  };
  // Fix combat strength in the isolated fixture to reach a boss deterministically regardless of the draft.
  function weakenEnemy() {
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE adventure_v1 SET state=json_set(state,'$.run.enemy.hp',1)").run();
    } finally { db.close(); }
  }
  await action('start', { skills: ['break', 'shield'] });
  if (snapshot.run.phase === 'root') await action('choose', { value: snapshot.run.options[0].id });
  selected = null;
  assert.equal(snapshot.run.pet.speciesId, baby.speciesId);
  await action('move', { value: 'shield' });
  assert.equal(snapshot.run.phase, 'battle');
  recovered();
  while (snapshot.run.cleared < 5) {
    if (snapshot.run.phase === 'battle') {
      weakenEnemy();
      await action('move', { value: 'attack' });
    } else {
      if (snapshot.run.phase === 'reward') {
        recovered();
        for (const { id, reward } of snapshot.run.options) {
          assert.equal(reward.level, snapshot.run.upgrades[id] ?? 0);
          assert.equal(reward.maxRank, 3);
          assert.ok(reward.effect);
        }
      }
      const options = snapshot.run.options;
      const choice = options.find((option) => /营地|休息/.test(option.name)) ?? options[0];
      await action('choose', { value: choice.id });
    }
  }
  while (snapshot.run.phase === 'reward') await action('choose', { value: snapshot.run.options[0].id });
  assert.equal(snapshot.run.phase, 'evolve');
  recovered();
  const unlockIds = snapshot.unlocks.map((u) => u.id);
  assert.ok(unlockIds.includes('first-boss'));
  assert.equal(new Set(unlockIds).size, unlockIds.length);
  const oldRevision = snapshot.revision;
  const value = snapshot.run.options[0].id;
  snapshot = readInFreshProcess(path, { action: 'adventure-choose', adventureRevision: oldRevision, value });
  assert.deepEqual(await status(), { ...snapshot, hasEvolutionData: false });
  assert.equal((await post({ action: 'adventure-choose', value, adventureRevision: oldRevision })).status, 409);
  assert.equal(snapshot.run.pet.speciesId, pet.speciesId);
  await action('equip', { kind: 'effect', value: 'first-boss' });
  await action('end');
  recovered();
  assert.equal(snapshot.best, 5);
  assert.equal(snapshot.equipped.effect, 'first-boss');
  assert.deepEqual(snapshot.unlocks.map((u) => u.id), unlockIds);
  assert.equal(cleanPet({ ...pet, adventureEffect: '首领之印' }).adventureEffect, '首领之印');
  assert.equal(cleanPet({ ...pet, adventureEffect: 'unknown' }).adventureEffect, undefined);
});
