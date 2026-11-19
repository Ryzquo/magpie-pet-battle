import { randomUUID } from 'node:crypto';
import { ArenaError, cleanPet } from './rooms.mjs';
import { arenaRequest } from './http.mjs';

const peerLifetime = 12_000;
export const challengeLifetime = 60_000;

export function createOnline({ getPet, relay }) {
  const id = randomUUID();
  const peers = new Map();
  const invites = new Map();
  let discovery = null;
  let error = null;

  function prune() {
    const now = Date.now();
    for (const [key, peer] of peers) if (peer.expires <= now) peers.delete(key);
    for (const [key, invite] of invites) if (invite.expires <= now) invites.delete(key);
  }

  function canAccept(invite, outgoingPeer) {
    // For crossed challenges, keep the room created by the smaller peer ID.
    return !outgoingPeer || (invite.from === outgoingPeer && invite.from < id);
  }

  function stop() {
    clearTimeout(discovery?.timer);
    discovery = null;
    error = null;
    peers.clear();
    invites.clear();
  }

  function discover(enabled) {
    if (!enabled) return stop();
    if (discovery) return;
    const current = {};
    discovery = current;
    async function tick() {
      if (discovery !== current) return;
      const { pet } = getPet();
      if (pet) {
        try {
          const result = await arenaRequest(relay, 'announce', { id, pet: cleanPet(pet) },
            { direct: relay.startsWith('http:') });
          if (discovery !== current) return;
          peers.clear();
          const now = Date.now();
          for (const entry of result.peers ?? []) {
            if (entry.id === id || typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) continue;
            peers.set(entry.id, { id: entry.id, name: entry.name, pet: entry.pet, expires: now + peerLifetime });
          }
          for (const entry of result.invites ?? []) {
            if (typeof entry.id !== 'string' || typeof entry.from !== 'string') continue;
            if (invites.has(entry.id)) continue;
            invites.set(entry.id, { id: entry.id, from: entry.from, name: entry.name, pet: entry.pet,
              code: entry.code, expires: now + challengeLifetime });
          }
          prune();
          error = null;
        } catch (problem) {
          if (discovery !== current) return;
          error = problem.status === 503 ? '无法连接对战服务，请检查网络。' : problem.message;
        }
      }
      if (discovery === current) current.timer = setTimeout(tick, 3500);
    }
    current.timer = setTimeout(tick, 0);
  }

  return {
    discover,
    view(outgoingPeer) {
      prune();
      const summary = ({ id, name, pet }) => ({ id, name, pet });
      return { discoverable: discovery !== null, peers: [...peers.values()].map(summary),
        invites: [...invites.values()].filter((invite) => canAccept(invite, outgoingPeer)).map(summary), error };
    },
    async challenge(peerId, code, pet) {
      prune();
      if (!peers.has(peerId)) throw new ArenaError(404, '对方已离线，请稍后重试。');
      if ([...invites.values()].some((invite) => invite.from === peerId)) {
        throw new ArenaError(409, '对方已经向你发起挑战，请在大厅接受。');
      }
      await arenaRequest(relay, 'invite', { from: id, target: peerId, code, pet },
        { direct: relay.startsWith('http:') });
    },
    getInvite(inviteId, outgoingPeer) {
      prune();
      const invite = invites.get(inviteId);
      if (!invite) throw new ArenaError(404, '邀请已过期，请重新发起挑战。');
      if (!canAccept(invite, outgoingPeer)) throw new ArenaError(409, '请先处理当前发出的挑战。');
      return invite;
    },
    removeInvite: (inviteId) => invites.delete(inviteId),
    removeInvitesFrom(peerId) {
      for (const [inviteId, invite] of invites) {
        if (invite.from === peerId) invites.delete(inviteId);
      }
    },
    close: stop,
  };
}
