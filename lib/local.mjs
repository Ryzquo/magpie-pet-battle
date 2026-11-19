import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ArenaError, cleanPet, createRooms, normalizeCode } from './rooms.mjs';
import { arenaRequest, handleError, listen, readBody, send } from './http.mjs';
import { createLan } from './lan.mjs';

const assets = new Map([
  ['/', ['arena.html', 'text/html']],
  ['/arena.js', ['arena.js', 'application/javascript']],
  ['/arena.css', ['arena.css', 'text/css']],
]);

function relayBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.href.slice(url.protocol.length + 2).split('/')[0].includes('@') || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !/^(?:localhost|\[::1\]|(?:127|10)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function startLocal({ getPet, port = 3572, relayUrl, udpPort }) {
  const secret = randomBytes(24).toString('base64url');
  const relay = relayBase(relayUrl);
  const rooms = createRooms();
  const lan = createLan({ rooms, getPet, udpPort });
  let link = null;
  let error = null;
  let busy = false;
  let revision = 0;

  function view() {
    const lanView = lan.view();
    return { ...getPet(), lan: lanView, room: link?.room ?? null, mode: link?.mode ?? null,
      error: error || lanView.error, relayConfigured: relay !== null };
  }

  async function roomAction(session, action, extra = {}) {
    const data = { code: session.room.code, key: session.key, ...extra };
    return session.base
      ? arenaRequest(session.base, 'room', { ...data, action }, { direct: session.base.startsWith('http:') })
      : rooms(action, data);
  }

  async function refresh() {
    if (!link || busy) return;
    const current = revision;
    try {
      const result = await roomAction(link, 'status');
      if (revision !== current || busy) return;
      link.room = result.room;
      error = null;
    } catch (problem) {
      if (revision !== current || busy) return;
      if ([403, 404].includes(problem.status)) link = null;
      error = problem.message;
    }
  }

  function petForBattle() {
    const { pet, petError } = getPet();
    if (!pet) throw new ArenaError(409, petError);
    return cleanPet(pet);
  }

  async function act(data) {
    if (data.action === 'resume') {
      await refresh();
      return;
    }
    if (busy) throw new ArenaError(409, '上一项操作仍在进行，请稍候。');
    busy = true;
    revision += 1;
    error = null;
    try {
      switch (data.action) {
        case 'discover':
          if (typeof data.enabled !== 'boolean') throw new ArenaError(400, '发现开关参数无效。');
          await lan.discover(data.enabled);
          return;
        case 'decline':
          lan.removeInvite(data.inviteId);
          return;
        case 'challenge':
        case 'accept':
        case 'create':
        case 'join': {
          if (link) throw new ArenaError(409, '请先退出当前房间。');
          const pet = petForBattle();
          if (data.action === 'challenge') {
            const result = rooms('create', { pet });
            try {
              await lan.challenge(data.peerId, result.room.code);
            } catch (problem) {
              rooms('leave', { code: result.room.code, key: result.key });
              throw problem;
            }
            link = { ...result, mode: 'lan', base: null };
            return;
          }
          if (data.action === 'accept') {
            const invite = lan.getInvite(data.inviteId);
            invite.joinKey ??= randomBytes(24).toString('base64url');
            const result = await arenaRequest(invite.base, 'room',
              { action: 'join', code: invite.code, key: invite.joinKey, pet }, { direct: true });
            lan.removeInvite(data.inviteId);
            link = { ...result, mode: 'lan', base: invite.base };
            return;
          }
          if (!relay) throw new ArenaError(409, '请先在插件选项中配置对战码服务地址。');
          const code = data.action === 'join' ? normalizeCode(data.code) : undefined;
          if (data.action === 'join' && joinAttempt?.code !== code) {
            joinAttempt = { code, key: randomBytes(24).toString('base64url') };
          }
          const result = await arenaRequest(relay, 'room', { action: data.action, code,
            key: data.action === 'join' ? joinAttempt.key : undefined, pet }, { direct: relay.startsWith('http:') });
          joinAttempt = null;
          link = { ...result, mode: 'code', base: relay };
          return;
        }
        case 'loadout':
        case 'ready':
        case 'move':
        case 'leave': {
          if (!link) throw new ArenaError(409, '请先加入房间。');
          const { move, round, points, skills } = data;
          const result = await roomAction(link, data.action, { move, round, points, skills });
          if (result.room) link.room = result.room;
          else link = null;
          return;
        }
        default:
          throw new ArenaError(400, '未知操作。');
      }
    } finally {
      busy = false;
    }
  }

  let joinAttempt = null;
  let pendingRefresh;
  const server = await listen(async (req, res) => {
    const actual = server.address()?.port;
    const host = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin;
    const local = `http://127.0.0.1:${actual}`;
    const localhost = `http://localhost:${actual}`;
    if (![ `127.0.0.1:${actual}`, `localhost:${actual}` ].includes(host) ||
        (origin && !['null', local, localhost].includes(origin))) {
      return send(res, 403, { error: '只服务本机对战页面。' });
    }
    const headers = {
      'access-control-allow-origin': origin || 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-arena-token',
      vary: 'Origin',
    };
    try {
      const path = new URL(req.url, local).pathname;
      if (path.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return send(res, 204, '', headers);
        const received = Buffer.from(String(req.headers['x-arena-token'] || ''));
        if (received.length !== secret.length || !timingSafeEqual(received, Buffer.from(secret))) {
          throw new ArenaError(401, '页面会话已失效，请重新打开宠物对战。');
        }
        if (path === '/api/status' && req.method === 'GET') {
          pendingRefresh ??= refresh().finally(() => { pendingRefresh = null; });
          await pendingRefresh;
          return send(res, 200, view(), headers);
        }
        if (path === '/api/action' && req.method === 'POST') {
          await act(await readBody(req));
          return send(res, 200, view(), headers);
        }
        throw new ArenaError(404, '接口不存在。');
      }
      const asset = assets.get(path);
      if (req.method !== 'GET' || !asset) throw new ArenaError(404, '页面不存在。');
      const [file, type] = asset;
      let body = await readFile(new URL(`../page/${file}`, import.meta.url), 'utf8');
      if (path === '/') body = body.replace('__ARENA_TOKEN__', secret);
      return send(res, 200, body, { 'content-type': `${type}; charset=utf-8`,
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src ${local} ${localhost}; style-src ${local} ${localhost}; connect-src ${local} ${localhost}; base-uri 'none'; form-action 'none'`,
      });
    } catch (problem) {
      return handleError(res, problem, headers);
    }
  }, port, '127.0.0.1');
  return { port: server.address().port, close() { lan.close(); server.close(); } };
}
