import { startLocal } from './lib/local.mjs';
import { createPetReader } from './lib/pet.mjs';

let starting;

export default {
  id: 'magpie-pet-battle',
  async server(input, options = {}) {
    starting ??= (async () => {
      const opts = options || {};
      const getPet = await createPetReader({ petDbPath: opts.petDbPath, configDir: input?.directory });
      const service = await startLocal({ getPet, relayUrl: opts.relayUrl });
      console.info(`[magpie-pet-battle] sidebar page at http://127.0.0.1:${service.port}/`);
    })().catch((error) => {
      console.error('[magpie-pet-battle] 页面服务启动失败:', error.message);
      starting = undefined;
    });
    await starting;
    return {};
  },
};
