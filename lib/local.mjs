import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import manifest from '../package.json' with { type: 'json' };
import { ArenaError, cleanPet, normalizeCode } from './rooms.mjs';
import { arenaRequest, handleError, listen, readBody, send } from './http.mjs';
import { challengeLifetime, createOnline } from './online.mjs';
import { loadWalletKey } from './wallet-key.mjs';

const defaultRelay = manifest.magpie.options.relayUrl;
const relayConfigError = '对战中继地址无效。请修改 relayUrl，或清空以使用共享中继。';

const assets = new Map([
  ['/', ['arena.html', 'text/html']],
  ['/arena.js', ['arena.js', 'application/javascript']],
  ['/arena.css', ['arena.css', 'text/css']],
  ['/stage.js', ['stage.js', 'application/javascript']],
  ['/stage.css', ['stage.css', 'text/css']],
]);

function relayBase(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return defaultRelay;
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.href.slice(url.protocol.length + 2).split('/')[0].includes('@') || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !/^(?:localhost|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})$/.test(url.hostname)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function startLocal({ getPet, petFrames, port = 3572, relayUrl }) {
  const secret = randomBytes(24).toString('base64url');
  const relay = relayBase(relayUrl);
  const online = createOnline({ getPet, relay });
  let link = null;
  let outgoing = null;
  let error = null;
  let busy = false;
  let revision = 0;

  function view() {
    const lobby = online.view(outgoing?.peerId);
    return { ...getPet(), lobby: { ...lobby, challengePending: outgoing !== null },
      room: link?.room ?? null, mode: link?.mode ?? null,
      error: error || lobby.error || (!relay ? relayConfigError : null), relayConfigured: relay !== null };
  }

  async function cancelChallenge() {
    const current = outgoing;
    outgoing = null;
    await roomAction(current, 'leave').catch(() => {});
  }

  async function syncChallenge() {
    if (!outgoing) return;
    try {
      const { room } = await roomAction(outgoing, 'status');
      if (room.players[1]) {
        link = { ...outgoing, room };
        online.removeInvitesFrom(outgoing.peerId);
        outgoing = null;
        error = null;
      }
    } catch (problem) {
      if (problem.status === 404) {
        outgoing = null;
        error = problem.message;
      }
    }
    if (outgoing && Date.now() >= outgoing.expires) {
      await cancelChallenge();
      error = '挑战已过期，可以重新发起挑战。';
    }
  }

  function requestRelay(path, data) {
    if (!relay) throw new ArenaError(409, relayConfigError);
    return arenaRequest(relay, path, data, { direct: relay.startsWith('http:') });
  }

  function roomAction(session, action, extra = {}) {
    return requestRelay('room', { code: session.room.code, key: session.key, ...extra, action });
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

  let pendingRefresh;

  function refreshStatus() {
    pendingRefresh ??= refresh().finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  }

  function petForBattle() {
    const { pet, petError } = getPet();
    if (!pet) throw new ArenaError(409, petError);
    return cleanPet(pet);
  }

  async function act(data) {
    if (data.action === 'resume') {
      await refreshStatus();
      return;
    }
    if (busy) throw new ArenaError(409, '上一项操作仍在进行，请稍候。');
    busy = true;
    revision += 1;
    try {
      await pendingRefresh;
      await syncChallenge();
      error = null;
      switch (data.action) {
        case 'discover':
          if (typeof data.enabled !== 'boolean') throw new ArenaError(400, '发现开关参数无效。');
          if (!data.enabled && outgoing) await cancelChallenge();
          if (data.enabled && !relay) throw new ArenaError(409, relayConfigError);
          online.discover(data.enabled);
          return;
        case 'cancel-challenge':
          if (!outgoing) throw new ArenaError(409, '当前没有待接受的挑战。');
          await cancelChallenge();
          return;
        case 'decline':
          online.removeInvite(data.inviteId);
          return;
        case 'challenge':
        case 'accept':
        case 'create':
        case 'join': {
          if (link) throw new ArenaError(409, '请先退出当前房间。');
          if (outgoing && data.action !== 'accept') throw new ArenaError(409, '请先取消已发出的挑战。');
          const pet = petForBattle();
          if (!relay) throw new ArenaError(409, relayConfigError);
          const walletKey = await loadWalletKey(relay);
          if (data.action === 'challenge') {
            const result = await requestRelay('room', { action: 'create', pet, walletKey });
            outgoing = { ...result, mode: 'online', peerId: data.peerId, expires: Date.now() + challengeLifetime };
            try {
              await online.challenge(data.peerId, result.room.code, pet);
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
            const invite = online.getInvite(data.inviteId, outgoing?.peerId);
            invite.joinKey ??= randomBytes(24).toString('base64url');
            let result;
            try {
              result = await requestRelay('room', { action: 'join', code: invite.code, key: invite.joinKey, pet, walletKey });
            } catch (problem) {
              if (problem.status === 404) online.removeInvite(data.inviteId);
              throw problem;
            }
            if (outgoing) await cancelChallenge();
            online.removeInvitesFrom(invite.from);
            link = { ...result, mode: 'online' };
            return;
          }
          const code = data.action === 'join' ? normalizeCode(data.code) : undefined;
          if (data.action === 'join' && joinAttempt?.code !== code) {
            joinAttempt = { code, key: randomBytes(24).toString('base64url') };
          }
          const result = await requestRelay('room', { action: data.action, code,
            key: data.action === 'join' ? joinAttempt.key : undefined, pet, walletKey });
          joinAttempt = null;
          link = { ...result, mode: 'code' };
          return;
        }
        case 'loadout':
        case 'ready':
        case 'move':
        case 'leave': {
          if (!link) throw new ArenaError(409, '请先加入房间。');
          const { move, turn, requestId, points, skills, reviewSettlement } = data;
          const fields = { move, turn, requestId, points, skills, reviewSettlement };
          let result;
          try {
            result = await roomAction(link, data.action, fields);
          } catch (problem) {
            if (data.action !== 'move' || !requestId || problem.status !== 503) throw problem;
            result = await roomAction(link, 'move', fields);
          }
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
      const frame = /^\/pet-frames\/([1-7]-\d{1,12})\/(\d{1,2})\.png$/.exec(path);
      if (req.method === 'GET' && frame) {
        const body = await petFrames?.read(frame[1], Number(frame[2]));
        if (!body) throw new ArenaError(404, '没有此宠物帧。');
        res.writeHead(200, { ...headers, 'content-type': 'image/png', 'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=3600' });
        return res.end(body);
      }
      if (path.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return send(res, 204, '', headers);
        const received = Buffer.from(String(req.headers['x-arena-token'] || ''));
        if (received.length !== secret.length || !timingSafeEqual(received, Buffer.from(secret))) {
          throw new ArenaError(401, '页面会话已失效，请重新打开宠物对战。');
        }
        const species = /^\/api\/sprite\/([1-7]-\d{1,12})$/.exec(path);
        if (req.method === 'GET' && species) {
          const frames = await petFrames?.list(species[1]);
          return send(res, 200, { frames: frames ?? [] }, headers);
        }
        if (path === '/api/status' && req.method === 'GET') {
          await refreshStatus();
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
      return send(res, 200, body, { ...headers, 'content-type': `${type}; charset=utf-8`,
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src ${local} ${localhost}; style-src ${local} ${localhost}; img-src ${local} ${localhost}; connect-src ${local} ${localhost}; base-uri 'none'; form-action 'none'`,
      });
    } catch (problem) {
      return handleError(res, problem, headers);
    }
  }, port, '127.0.0.1');
  return { port: server.address().port, close() { online.close(); server.close(); } };
}
