import { createServer } from 'node:http';
import { ArenaError } from './rooms.mjs';

export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new ArenaError(415, '请求需要使用 JSON。');
  }
  let body = '';
  req.setEncoding('utf8');
  for await (const part of req) {
    body += part;
    if (Buffer.byteLength(body) > 4096) throw new ArenaError(413, '请求过大。');
  }
  try {
    const data = JSON.parse(body);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new ArenaError(400, '请求格式无效。');
  }
}

export function listen(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer({ requestTimeout: 8_000, headersTimeout: 5_000, keepAliveTimeout: 2_000 }, handler);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export function handleError(res, error, headers) {
  if (!(error instanceof ArenaError)) console.error('[magpie-pet-battle]', error?.message);
  send(res, error instanceof ArenaError ? error.status : 500,
    { error: error instanceof ArenaError ? error.message : '对战服务暂时不可用。' }, headers);
}

export function roomHandler(rooms) {
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      if (req.method !== 'POST') throw new ArenaError(404, '接口不存在。');
      if (req.url === '/arena/v1/room' || req.url === '/arena/v1/invite') {
        throw new ArenaError(426, '对战规则已更新，请将双方插件更新到 0.2.0 或更高版本。');
      }
      if (req.url !== '/arena/v2/room') throw new ArenaError(404, '接口不存在。');
      const data = await readBody(req);
      return send(res, 200, rooms(data.action, data));
    } catch (error) {
      return handleError(res, error);
    }
  };
}

export async function arenaRequest(base, path, data, { direct = false } = {}) {
  let response;
  let result;
  try {
    response = await fetch(`${base}/arena/v2/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(3500), redirect: 'error',
      ...(direct && process.versions.bun ? { proxy: false } : {}),
    });
    result = await response.json();
  } catch {
    throw new ArenaError(503, '连接暂时中断，请确认双方在线后重试。');
  }
  if (!response.ok) throw new ArenaError(response.status, typeof result?.error === 'string' ? result.error : '对战请求失败。');
  return result;
}
