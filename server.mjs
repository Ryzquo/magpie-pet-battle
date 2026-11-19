import { listen } from './lib/http.mjs';
import { createHub, hubHandler } from './lib/hub.mjs';
import { createRooms } from './lib/rooms.mjs';

const host = process.env.ARENA_HOST || '127.0.0.1';
const port = Number(process.env.ARENA_PORT || process.env.PORT || 3574);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARENA_PORT must be a TCP port');
const server = await listen(hubHandler(createHub(), createRooms()), port, host);
console.log(`Magpie pet battle room service listening on ${host}:${server.address().port}`);
