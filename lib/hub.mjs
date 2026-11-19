import { ArenaError, cleanPet, normalizeCode } from './rooms.mjs';
import { handleError, readBody, roomHandler, send } from './http.mjs';

const peerLifetime = 16_000;
const inviteLifetime = 60_000;
const maxPeers = 512;
const maxInvites = 48;

/**
 * 公网在线大厅：玩家定时心跳注册，挑战通过服务器收件箱投递。
 * 房间本身仍由 rooms 房间服务托管，双方通过中继完成对战。
 */
export function createHub({ clock = Date.now } = {}) {
  const peers = new Map();
  const inboxes = new Map();

  function prune() {
    const now = clock();
    for (const [id, peer] of peers) if (peer.expires <= now) peers.delete(id);
    for (const [id, box] of inboxes) {
      for (const [inviteId, invite] of box) if (invite.expires <= now) box.delete(inviteId);
      if (!box.size) inboxes.delete(id);
    }
  }

  function announce(data = {}) {
    prune();
    const { id } = data;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ArenaError(400, '在线身份无效。');
    const pet = cleanPet(data.pet);
    if (!peers.has(id) && peers.size >= maxPeers) throw new ArenaError(503, '在线大厅已满，请稍后再试。');
    peers.set(id, { id, name: pet.name, pet, expires: clock() + peerLifetime });
    const box = inboxes.get(id);
    const invites = box ? [...box.values()].map(({ id: inviteId, from, name, pet, code }) => ({ id: inviteId, from, name, pet, code })) : [];
    if (box) box.clear();
    return {
      peers: [...peers.values()].filter((peer) => peer.id !== id).map(({ id, name, pet }) => ({ id, name, pet })),
      invites,
    };
  }

  function invite(data = {}) {
    prune();
    const { from, target } = data;
    if (typeof from !== 'string' || typeof target !== 'string') throw new ArenaError(400, '挑战信息无效。');
    if (!peers.has(from)) throw new ArenaError(403, '请先开启在线发现。');
    const code = normalizeCode(data.code);
    if (!peers.has(target)) throw new ArenaError(404, '对方已离线，请稍后重试。');
    const sender = peers.get(from);
    let box = inboxes.get(target);
    if (!box) {
      box = new Map();
      inboxes.set(target, box);
    }
    const inviteId = `${from}/${code}`;
    if (!box.has(inviteId) && box.size >= maxInvites) throw new ArenaError(429, '对方的待处理邀请已满。');
    box.set(inviteId, { id: inviteId, from, name: sender.name, pet: sender.pet, code, expires: clock() + inviteLifetime });
    return { ok: true };
  }

  return { announce, invite };
}

export function hubHandler(hub, rooms) {
  const room = roomHandler(rooms);
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && req.url === '/arena/v2/announce') {
        return send(res, 200, hub.announce(await readBody(req)));
      }
      if (req.method === 'POST' && req.url === '/arena/v2/invite') {
        return send(res, 200, hub.invite(await readBody(req)));
      }
      return room(req, res);
    } catch (error) {
      return handleError(res, error);
    }
  };
}
