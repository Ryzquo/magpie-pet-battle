import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function createPetFrames({ packageDir, nodeById }) {
  if (!nodeById) return null;
  let root, map;
  try {
    root = await realpath(join(packageDir, 'sprites'));
    map = JSON.parse(await readFile(join(packageDir, 'lib', 'sprite-map.json'), 'utf8'));
  } catch {
    return null;
  }

  const cache = new Map();
  async function resolveFrames(directory) {
    const path = await realpath(join(root, directory));
    if (dirname(path) !== root) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    return Array.from({ length: 8 }, (_, index) => {
      const name = `${index}.png`;
      return [0, 1, 2, 6, 7].includes(index) && names.has(name) ? join(path, name) : null;
    });
  }

  async function files(id) {
    if (!/^[1-7]-\d{1,12}$/.test(id)) return [];
    const node = nodeById(id);
    if (!node) return [];
    const name = node.name_en;
    const directory = Object.hasOwn(map, name) ? map[name] : map[`${name}#${node.stage}`];
    if (typeof directory !== 'string' || !directory || /[/\\]/.test(directory)) return [];
    if (!cache.has(directory)) cache.set(directory, resolveFrames(directory).catch(() => []));
    return cache.get(directory);
  }

  return {
    async list(id) {
      return (await files(id)).map((file, index) => file && `/pet-frames/${id}/${index}.png`);
    },
    async read(id, index) {
      const file = (await files(id))[index];
      return file ? readFile(file).catch(() => null) : null;
    },
  };
}
