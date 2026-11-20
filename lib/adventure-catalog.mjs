import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPetCatalog } from './pet.mjs';

export async function loadAdventureCatalog(configDir) {
  const { packageDir, combatById } = await loadPetCatalog(configDir);
  const forms = new Map();
  const children = new Map();
  const parents = new Map();
  let records;
  try {
    const adapter = pathToFileURL(join(packageDir, 'lib', 'pet.adapter.mjs'));
    ({ DIGIMON_DATA: records } = await import(adapter.href));
  } catch {
    // The installed adapter requires Bun and may be missing in a standalone runtime.
  }
  if (Array.isArray(records)) {
    for (const node of records) {
      if (typeof node?.id !== 'string' || !/^[1-7]-\d+$/.test(node.id) ||
        !Number.isInteger(node.stage) || node.stage < 1 || node.stage > 7) continue;
      const stats = combatById?.get(node.id);
      forms.set(node.id, Object.freeze({ speciesId: node.id, species: node.name_zh || node.name_en || node.id,
        stage: node.stage, ...(stats && { combatStats: Object.freeze({ ...stats }) }) }));
    }
    // Magpie's pet trials use the published next_evolutions list. Each adventure evolution advances a stage.
    for (const node of records) {
      const source = forms.get(node?.id);
      if (!source || !Array.isArray(node.next_evolutions)) continue;
      const targets = [...new Set(node.next_evolutions)].filter((id) => forms.get(id)?.stage > source.stage);
      children.set(source.speciesId, targets);
      for (const id of targets) {
        if (!parents.has(id)) parents.set(id, []);
        parents.get(id).push(source.speciesId);
      }
    }
  }

  return {
    roots(speciesId) {
      const source = forms.get(speciesId);
      if (!source) return [];
      const ancestors = new Set([speciesId]);
      let lowest = source.stage;
      for (const id of ancestors) {
        lowest = Math.min(lowest, forms.get(id).stage);
        for (const parent of parents.get(id) ?? []) ancestors.add(parent);
      }
      return [...ancestors].filter((id) => forms.get(id).stage === lowest).sort().map((id) => forms.get(id));
    },
    successors(speciesId) {
      return (children.get(speciesId) ?? []).map((id) => forms.get(id));
    },
  };
}
