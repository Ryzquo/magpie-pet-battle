import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAdventureCatalog } from '../lib/adventure-catalog.mjs';

async function fixture(t, records) {
  const configDir = await mkdtemp(join(tmpdir(), 'pet-battle-catalog-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  if (!records) return configDir;
  const lib = join(configDir, 'plugins', 'node_modules', 'magpie-digital-pet', 'lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'pet.adapter.mjs'), `export const DIGIMON_DATA = ${JSON.stringify(records)};`);
  return configDir;
}

function node(id, next_evolutions, names = {}) {
  return { id, stage: Number(id[0]), next_evolutions, ...names };
}

const ids = (forms) => forms.map(({ speciesId }) => speciesId);

test('catalog finds the lowest reachable forms across converging evolution branches', async (t) => {
  const config = await fixture(t, [
    node('0-001', ['1-001', '1-002', '1-003']),
    node('1-002', ['2-002']),
    node('1-001', ['2-001'], { name_en: 'Seed', name_zh: '种子兽' }),
    node('1-003', []),
    node('2-001', ['3-001']),
    node('2-002', ['3-001']),
    node('2-003', ['3-001']),
    node('3-001', [], { name_en: 'Bloom' }),
  ]);
  const { roots } = await loadAdventureCatalog(config);
  assert.deepEqual(roots('3-001'), [
    { speciesId: '1-001', species: '种子兽', stage: 1 },
    { speciesId: '1-002', species: '1-002', stage: 1 },
  ]);
  assert.deepEqual(ids(roots('1-003')), ['1-003']);
  assert.deepEqual(ids(roots('2-003')), ['2-003']);
  assert.deepEqual(roots('0-001'), []);
  assert.deepEqual(roots('7-999'), []);
});

test('successors retain catalog order and accept only existing higher-stage targets', async (t) => {
  const config = await fixture(t, [
    node('1-001', ['2-001']),
    node('2-001', ['4-001', '3-001', '4-001', '2-002', '1-001', '3-999', 'other']),
    node('2-002', []),
    node('3-001', [], { name_en: 'Bloom' }),
    node('4-001', []),
    { id: 'other', stage: 5, next_evolutions: [] },
  ]);
  const { successors } = await loadAdventureCatalog(config);
  assert.deepEqual(successors('2-001'), [
    { speciesId: '4-001', species: '4-001', stage: 4 },
    { speciesId: '3-001', species: 'Bloom', stage: 3 },
  ]);
  assert.deepEqual(successors('4-001'), []);
  assert.deepEqual(successors('9-999'), []);
});

test('missing pet data leaves both lookups empty', async (t) => {
  const { roots, successors } = await loadAdventureCatalog(await fixture(t));
  assert.deepEqual(roots('3-001'), []);
  assert.deepEqual(successors('3-001'), []);
});
