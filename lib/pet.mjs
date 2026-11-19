import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const noPet = '请先在「宠物」页孵化并选择一只出战宠物。';

function configPath(configDir) {
  return configDir || (process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, 'magpie')) ||
    join(homedir(), '.config', 'magpie');
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function cleanCare(row) {
  if (!row) return null;
  const value = (key) => Number.isFinite(row[key]) ? Math.max(0, Math.round(row[key])) : 0;
  return { satiety: value('satiety'), mood: value('mood'), energy: value('energy'),
    hygiene: value('hygiene'), bond: value('bond') };
}

export function spriteRootFor({ configDir } = {}) {
  return join(configPath(configDir), 'plugins', 'node_modules', 'magpie-digital-pet', 'sprites');
}

export async function createPetReader({ petDbPath, configDir } = {}) {
  const config = configPath(configDir);
  const packageDir = join(config, 'plugins', 'node_modules', 'magpie-digital-pet');
  const manifest = join(packageDir, 'package.json');
  const spriteMap = readJson(join(packageDir, 'lib', 'sprite-map.json'), {});
  const attributeMap = readJson(join(packageDir, 'lib', 'digimon-attributes.json'), {});
  let nodeById;
  if (existsSync(manifest)) {
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).version === '0.6.0' && process.versions.bun) {
        ({ nodeById } = await import(pathToFileURL(join(packageDir, 'lib', 'pet.adapter.mjs')).href));
      }
    } catch {
      // The species ID is sufficient if the catalog cannot be loaded.
    }
  }
  const dataRoot = process.platform === 'win32'
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : join(homedir(), '.config');
  const path = typeof petDbPath === 'string' && petDbPath.trim()
    ? resolve(petDbPath.trim()) : join(dataRoot, 'magpie-digital-pet', 'pet.db');
  const open = process.versions.bun
    ? await import('bun:sqlite').then(({ Database }) => () => new Database(path, { readonly: true }))
    : await import('node:sqlite').then(({ DatabaseSync }) => () => new DatabaseSync(path, { readOnly: true }));
  let cached;
  let lastRead = 0;

  return function getPet() {
    const now = Date.now();
    if (cached && now - lastRead < 1000) return cached;
    lastRead = now;
    try {
      if (!existsSync(path)) return cached = { pet: null, petError: noPet };
      const db = open();
      try {
        const current = db.prepare(`
          SELECT partner_id, current_node_id, gauge, generation FROM partners
          WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
            AND retired_at IS NULL
        `).get();
        const id = current?.current_node_id;
        if (typeof id !== 'string' || !/^[1-7]-\d+$/.test(id)) return cached = { pet: null, petError: noPet };
        const hasNames = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='magpie_pet_names'").get();
        const nickname = hasNames && db.prepare('SELECT name FROM magpie_pet_names WHERE partner_id = ?')
          .get(current.partner_id)?.name;
        const node = nodeById?.(id);
        const nameEn = node?.name_en || node?.nameEn;
        const stage = node?.stage ?? Number(id[0]);
        const species = node?.name_zh || nameEn || id;
        const sprite = nameEn ? spriteMap[nameEn] ?? spriteMap[`${nameEn}#${stage}`] : undefined;
        const rawAttribute = attributeMap[id];
        const attribute = typeof rawAttribute === 'string' ? rawAttribute.toLowerCase() : undefined;
        let care = null;
        try {
          care = cleanCare(db.prepare(`
            SELECT satiety, mood, energy, hygiene, bond FROM magpie_pet_care_state
            WHERE partner_id = ?
          `).get(current.partner_id));
        } catch {
          // Older saves may not have the care layer yet.
        }
        return cached = { pet: { name: nickname || species, species, nameEn: nameEn || undefined,
          speciesId: id, stage, sprite: sprite || undefined, attribute, care }, petError: null };
      } finally {
        db.close();
      }
    } catch {
      return cached = { pet: null, petError: '暂时无法读取宠物存档，请核对存档路径和插件版本。' };
    }
  };
}
