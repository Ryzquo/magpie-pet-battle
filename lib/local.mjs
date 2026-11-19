import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ArenaError, cleanPet, createRooms, normalizeCode } from './rooms.mjs';
import { arenaRequest, handleError, listen, readBody, send } from './http.mjs';
import { challengeLifetime, createLan } from './lan.mjs';

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
    if (url.protocol === 'http:' && !/^(?:localhost|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})$/.test(url.hostname)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function startLocal({ getPet, port = 3572, relayUrl, udpPort, spriteRoot }) {
  const spriteDir = spriteRoot ? resolve(spriteRoot) : null;
  const secret = randomBytes(24).toString('base64url');
  const relay = relayBase(relayUrl);
  const rooms = createRooms();
  const lan = createLan({ rooms, getPet, udpPort, relay });
  let link = null;
  let outgoing = null;
  let error = null;
  let busy = false;
  let revision = 0;

  function view() {
    const lanView = lan.view(outgoing?.peerId);
    return { ...getPet(), lan: { ...lanView, challengePending: outgoing !== null },
      room: link?.room ?? null, mode: link?.mode ?? null,
      error: error || lanView.error, relayConfigured: relay !== null };
  }

  async function cancelChallenge() {
    const current = outgoing;
    outgoing = null;
    if (current.base) {
      await arenaRequest(current.base, 'room',
        { action: 'leave', code: current.room.code, key: current.key },
        { direct: current.base.startsWith('http:') }).catch(() => {});
      return;
    }
    rooms('leave', { code: current.room.code, key: current.key });
  }

  async function syncChallenge() {
    if (!outgoing) return;
    try {
      const { room } = await roomAction(outgoing, 'status');
      if (room.players[1]) {
        link = { ...outgoing, room };
        lan.removeInvitesFrom(outgoing.peerId);
        outgoing = null;
        error = null;
      } else if (Date.now() >= outgoing.expires) {
        await cancelChallenge();
        error = '挑战已过期，可以重新发起挑战。';
      }
    } catch (problem) {
      if (problem.status === 404) {
        outgoing = null;
        error = problem.message;
      }
    }
  }

  async function roomAction(session, action, extra = {}) {
    const data = { code: session.room.code, key: session.key, ...extra };
    return session.base
      ? arenaRequest(session.base, 'room', { ...data, action }, { direct: session.base.startsWith('http:') })
      : rooms(action, data);
  }

  async function refresh() {
    if (busy) return;
    await syncChallenge();
    if (!link) return;
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
    await syncChallenge();
    busy = true;
    revision += 1;
    error = null;
    try {
      switch (data.action) {
        case 'discover':
          if (typeof data.enabled !== 'boolean') throw new ArenaError(400, '发现开关参数无效。');
          if (!data.enabled && outgoing) await cancelChallenge();
          await lan.discover(data.enabled);
          return;
        case 'cancel-challenge':
          if (!outgoing) throw new ArenaError(409, '当前没有待接受的挑战。');
          await cancelChallenge();
          return;
        case 'decline':
          lan.removeInvite(data.inviteId);
          return;
        case 'challenge':
        case 'accept':
        case 'create':
        case 'join': {
          if (link) throw new ArenaError(409, '请先退出当前房间。');
          if (outgoing && data.action !== 'accept') throw new ArenaError(409, '请先取消已发出的挑战。');
          const pet = petForBattle();
          if (data.action === 'challenge') {
            const online = lan.onlineEnabled();
            const result = online
              ? await arenaRequest(relay, 'room', { action: 'create', pet }, { direct: relay.startsWith('http:') })
              : rooms('create', { pet });
            outgoing = { ...result, mode: online ? 'online' : 'lan', base: online ? relay : null,
              peerId: data.peerId, expires: Date.now() + challengeLifetime };
            try {
              await lan.challenge(data.peerId, result.room.code);
            } catch (problem) {
              await syncChallenge();
              if (link) return;
              if (outgoing) await cancelChallenge();
              throw problem;
            }
            await syncChallenge();
            return;
          }
          if (data.action === 'accept') {
            const invite = lan.getInvite(data.inviteId, outgoing?.peerId);
            invite.joinKey ??= randomBytes(24).toString('base64url');
            let result;
            try {
              result = await arenaRequest(invite.base, 'room',
                { action: 'join', code: invite.code, key: invite.joinKey, pet },
                { direct: invite.base.startsWith('http:') });
            } catch (problem) {
              if (problem.status === 404) lan.removeInvite(data.inviteId);
              throw problem;
            }
            if (outgoing) await cancelChallenge();
            lan.removeInvitesFrom(invite.from);
            link = { ...result, mode: invite.online ? 'online' : 'lan', base: invite.base };
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

  const recentActions = new Map();

  async function runPageAction(data) {
    const { requestId } = data;
    if (requestId === undefined) return act(data);
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) {
      throw new ArenaError(400, '操作编号无效。');
    }
    const now = Date.now();
    for (const [id, entry] of recentActions) {
      if (entry.expires <= now) recentActions.delete(id);
    }
    const payload = JSON.stringify(data);
    const previous = recentActions.get(requestId);
    if (previous) {
      if (previous.payload !== payload) throw new ArenaError(409, '操作编号已用于其他请求。');
      return previous.result;
    }
    if (recentActions.size >= 128) throw new ArenaError(429, '操作过于频繁，请稍候。');
    const entry = { payload, expires: Infinity };
    entry.result = act(data).finally(() => { entry.expires = Date.now() + 30_000; });
    recentActions.set(requestId, entry);
    return entry.result;
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
      if (path.startsWith('/sprite/') && req.method === 'GET') {
        if (!spriteDir) throw new ArenaError(404, '未找到宠物形象资源。');
        let rel;
        try {
          rel = decodeURIComponent(path.slice('/sprite/'.length));
        } catch {
          throw new ArenaError(400, '形象路径无效。');
        }
        const file = resolve(spriteDir, rel);
        const inside = relative(spriteDir, file);
        if (inside.startsWith('..') || isAbsolute(inside) || !file.endsWith('.png')) {
          throw new ArenaError(403, '禁止访问。');
        }
        const data = await readFile(file).catch(() => null);
        if (!data) throw new ArenaError(404, '形象不存在。');
        return send(res, 200, data, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      }
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
          await runPageAction(await readBody(req));
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
        'content-security-policy': `default-src 'none'; script-src ${local} ${localhost}; style-src ${local} ${localhost}; img-src 'self'; connect-src ${local} ${localhost}; base-uri 'none'; form-action 'none'`,
      });
    } catch (problem) {
      return handleError(res, problem, headers);
    }
  }, port, '127.0.0.1');
  return { port: server.address().port, close() { lan.close(); server.close(); } };
}
