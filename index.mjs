import { startLocal } from './lib/local.mjs';
import { createPetReader, loadPetCatalog } from './lib/pet.mjs';
import { createPetFrames } from './lib/pet-frames.mjs';

let starting;

export default {
  id: 'magpie-pet-battle',
  async server(input, options = {}) {
    starting ??= (async () => {
      const opts = options || {};
      const catalog = await loadPetCatalog(input?.directory);
      const [getPet, petFrames] = await Promise.all([
        createPetReader({ petDbPath: opts.petDbPath, catalog }),
        createPetFrames(catalog),
      ]);
      const service = await startLocal({ getPet, petFrames, relayUrl: opts.relayUrl });
      console.info(`[magpie-pet-battle] sidebar page at http://127.0.0.1:${service.port}/`);
    })().catch((error) => {
      console.error('[magpie-pet-battle] 页面服务启动失败:', error.message);
      starting = undefined;
    });
    await starting;
    return {};
  },
};
