import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { ArenaError, cleanPet, normalizeCode } from './rooms.mjs';
import { arenaRequest, listen, roomHandler } from './http.mjs';

const group = '239.255.77.82';
const discoveryPort = 35733;
const peerLifetime = 7500;
const onlinePeerLifetime = 12_000;
export const challengeLifetime = 60_000;
const protocol = 'magpie-pet-battle/2';

export function createLan({ rooms, getPet, udpPort = discoveryPort, relay = null }) {
  const id = randomUUID();
  const peers = new Map();
  const invites = new Map();
  let socket;
  let interval;
  let onlineTimer;
  let online = false;
  let server;
  let discoveryError = null;
  let onlineError = null;
  let interfaces = [];
  let announcing = false;

  function prune() {
    const now = Date.now();
    for (const [key, peer] of peers) if (peer.expires <= now) peers.delete(key);
    for (const [key, invite] of invites) if (invite.expires <= now) invites.delete(key);
  }

  function receiveInvite(data, ip) {
    prune();
    const sender = peers.get(data.from);
    if (!socket || data.target !== id || !sender?.addresses.has(ip)) {
      throw new ArenaError(409, '双方需打开局域网发现，再重新发起挑战。');
    }
    const code = normalizeCode(data.code);
    const inviteId = `${data.from}/${code}`;
    if (!invites.has(inviteId) && invites.size >= 24) throw new ArenaError(429, '对方的待处理邀请已满。');
    invites.set(inviteId, { id: inviteId, from: data.from, name: sender.name, pet: sender.pet,
      base: sender.addresses.get(ip), code, expires: Date.now() + challengeLifetime });
  }

  function canAccept(invite, outgoingPeer) {
    // For crossed challenges, keep the room hosted by the smaller peer ID.
    return !outgoingPeer || (invite.from === outgoingPeer && invite.from < id);
  }

  function announce() {
    if (!socket || announcing) return;
    prune();
    const { pet } = getPet();
    if (!pet) return;
    const current = socket;
    const data = JSON.stringify({ protocol, id, port: server.address().port, pet });
    announcing = true;
    let sent = false;
    function sendOn(index) {
      if (socket !== current) return;
      if (index === interfaces.length) {
        announcing = false;
        discoveryError = sent ? null : '无法发送局域网发现广播，请检查网络连接。';
        return;
      }
      try {
        current.setMulticastInterface(interfaces[index]);
        current.send(data, udpPort, group, (error) => {
          sent ||= !error;
          sendOn(index + 1);
        });
      } catch {
        sendOn(index + 1);
      }
    }
    sendOn(0);
  }

  function receive(message, source) {
    if (message.length > 1024 || !isIPv4(source.address)) return;
    try {
      const entry = JSON.parse(message.toString());
      if (entry.protocol !== protocol || entry.id === id ||
          typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id) ||
          !Number.isInteger(entry.port) || entry.port < 1024 || entry.port > 65535) return;
      const pet = cleanPet(entry.pet);
      prune();
      const oldPeer = peers.get(entry.id);
      if (!oldPeer && peers.size >= 128) return;
      const addresses = oldPeer?.addresses ?? new Map();
      if (addresses.size >= 8 && !addresses.has(source.address)) return;
      addresses.set(source.address, `http://${source.address}:${entry.port}`);
      peers.set(entry.id, { id: entry.id, name: pet.name, pet, addresses, expires: Date.now() + peerLifetime });
      if (!oldPeer) announce();
    } catch {
      // Ignore unrelated or incompatible discovery messages.
    }
  }

  function stop() {
    clearInterval(interval);
    clearTimeout(onlineTimer);
    online = false;
    onlineTimer = undefined;
    const current = socket;
    socket = undefined;
    announcing = false;
    interfaces = [];
    if (current) current.close();
    peers.clear();
    invites.clear();
  }

  async function startOnline() {
    if (online) return;
    online = true;
    onlineError = null;
    peers.clear();
    invites.clear();
    const tick = async () => {
      if (!online) return;
      const { pet } = getPet();
      if (pet) {
        try {
          const result = await arenaRequest(relay, 'announce', { id, pet: cleanPet(pet) },
            { direct: relay.startsWith('http:') });
          if (!online) return;
          const now = Date.now();
          const nextPeers = new Map();
          for (const entry of result.peers ?? []) {
            if (entry.id === id || typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) continue;
            nextPeers.set(entry.id, { id: entry.id, name: entry.name, pet: entry.pet,
              addresses: new Map(), expires: now + onlinePeerLifetime });
          }
          peers.clear();
          for (const [key, value] of nextPeers) peers.set(key, value);
          for (const entry of result.invites ?? []) {
            if (typeof entry.id !== 'string' || typeof entry.from !== 'string') continue;
            invites.set(entry.id, { id: entry.id, from: entry.from, name: entry.name, pet: entry.pet,
              base: relay, online: true, code: entry.code, expires: now + challengeLifetime });
          }
          for (const [key, invite] of invites) if (invite.expires <= now) invites.delete(key);
          onlineError = null;
        } catch (problem) {
          if (!online) return;
          onlineError = problem.status === 503 ? '无法连接对战服务，请检查网络。' : problem.message;
        }
      }
      if (online) onlineTimer = setTimeout(tick, 3500);
    };
    onlineTimer = setTimeout(tick, 0);
  }

  async function discover(enabled) {
    if (!enabled) {
      stop();
      discoveryError = null;
      onlineError = null;
      return;
    }
    if (relay) return startOnline();
    if (socket) return;
    discoveryError = null;
    server ??= await listen(roomHandler(rooms, { invite: receiveInvite, allowCreate: false }), 0, '0.0.0.0');
    server.unref();
    const next = createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise((resolve, reject) => {
        next.once('error', reject);
        next.bind(udpPort, () => {
          try {
            const addresses = new Set(Object.values(networkInterfaces()).flat()
              .filter((entry) => entry && !entry.internal && entry.family === 'IPv4').map((entry) => entry.address));
            interfaces = [...addresses].filter((address) => {
              try {
                next.addMembership(group, address);
                return true;
              } catch {
                return false;
              }
            });
            if (!interfaces.length) throw new Error('No IPv4 multicast interface');
            next.setMulticastTTL(1);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    } catch {
      next.close();
      throw new ArenaError(503, '无法启动局域网发现，请检查 UDP 端口和网络权限。');
    }
    next.removeAllListeners('error');
    socket = next;
    next.on('error', () => {
      stop();
      discoveryError = '局域网发现已中断，请重新开启。';
    });
    next.on('message', receive);
    next.unref();
    announce();
    interval = setInterval(announce, 2300);
    interval.unref();
  }

  return {
    discover,
    onlineEnabled: () => online,
    view(outgoingPeer) {
      prune();
      const summary = ({ id, name, pet }) => ({ id, name, pet });
      return { discoverable: relay ? online : Boolean(socket), peers: [...peers.values()].map(summary),
        invites: [...invites.values()].filter((invite) => canAccept(invite, outgoingPeer)).map(summary),
        error: onlineError || discoveryError };
    },
    async challenge(peerId, code) {
      prune();
      const peer = peers.get(peerId);
      if (!peer) throw new ArenaError(404, '对方已离线，请重新扫描。');
      if ([...invites.values()].some((invite) => invite.from === peerId)) {
        throw new ArenaError(409, '对方已经向你发起挑战，请在大厅接受。');
      }
      if (relay && online) {
        const { pet } = getPet();
        if (!pet) throw new ArenaError(409, '请先在宠物页选择出战宠物。');
        await arenaRequest(relay, 'invite', { from: id, target: peer.id, code, pet: cleanPet(pet) },
          { direct: relay.startsWith('http:') });
        return;
      }
      try {
        await Promise.any([...peer.addresses.values()].map((base) =>
          arenaRequest(base, 'invite', { from: id, target: peer.id, code }, { direct: true })));
      } catch (problem) {
        throw problem.errors?.find((error) => error.status !== 503) ?? problem.errors?.[0] ?? problem;
      }
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
    close() {
      stop();
      server?.close();
    },
  };
}
