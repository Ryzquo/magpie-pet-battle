import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { ArenaError, cleanPet, normalizeCode } from './rooms.mjs';
import { arenaRequest, listen, roomHandler } from './http.mjs';

const group = '239.255.77.82';
const discoveryPort = 35733;
const peerLifetime = 7500;
const inviteLifetime = 60_000;
const protocol = 'magpie-pet-battle/1';

export function createLan({ rooms, getPet, udpPort = discoveryPort }) {
  const id = randomUUID();
  const peers = new Map();
  const invites = new Map();
  let socket;
  let interval;
  let server;
  let discoveryError = null;
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
    invites.set(inviteId, { id: inviteId, name: sender.name, pet: sender.pet, base: sender.addresses.get(ip), code,
      expires: Date.now() + inviteLifetime });
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
    const current = socket;
    socket = undefined;
    announcing = false;
    interfaces = [];
    if (current) current.close();
    peers.clear();
    invites.clear();
  }

  async function discover(enabled) {
    if (!enabled) {
      stop();
      discoveryError = null;
      return;
    }
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
    view() {
      prune();
      const summary = ({ id, name, pet }) => ({ id, name, pet });
      return { discoverable: Boolean(socket), peers: [...peers.values()].map(summary),
        invites: [...invites.values()].map(summary), error: discoveryError };
    },
    async challenge(peerId, code) {
      prune();
      const peer = peers.get(peerId);
      if (!peer) throw new ArenaError(404, '对方已离线，请重新扫描。');
      try {
        await Promise.any([...peer.addresses.values()].map((base) =>
          arenaRequest(base, 'invite', { from: id, target: peer.id, code }, { direct: true })));
      } catch (problem) {
        throw problem.errors?.find((error) => error.status !== 503) ?? problem.errors?.[0] ?? problem;
      }
    },
    getInvite(inviteId) {
      prune();
      const invite = invites.get(inviteId);
      if (!invite) throw new ArenaError(404, '邀请已过期，请重新发起挑战。');
      return invite;
    },
    removeInvite: (inviteId) => invites.delete(inviteId),
    close() {
      stop();
      server?.close();
    },
  };
}
