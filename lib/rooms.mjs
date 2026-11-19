import { randomBytes, randomInt } from 'node:crypto';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const beats = { strike: 'focus', guard: 'strike', focus: 'guard' };
const labels = { strike: '猛攻', guard: '防守', focus: '聚力' };
const idleMs = 20 * 60_000;
const token = () => randomBytes(24).toString('base64url');

export class ArenaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function cleanPet(value) {
  if (!value || typeof value.name !== 'string' || typeof value.species !== 'string' ||
      !Number.isInteger(value.stage) || value.stage < 1 || value.stage > 7) {
    throw new ArenaError(400, '请先在宠物页孵化并选择一只出战宠物。');
  }
  const name = value.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 36);
  const species = value.species.trim().slice(0, 40);
  if (!name || !species) throw new ArenaError(400, '宠物资料不完整。');
  return { name, species, stage: value.stage };
}

export function normalizeCode(code) {
  const value = typeof code === 'string' ? code.trim().toUpperCase().replace(/[ -]/g, '') : '';
  if (value.length !== 8 || [...value].some((char) => !alphabet.includes(char))) {
    throw new ArenaError(400, '请输入有效的 8 位对战码。');
  }
  return value;
}

function makePlayer(pet, key) {
  return { pet: cleanPet(pet), key, ready: false, hp: 3, move: null };
}

function roomView(room, you) {
  return {
    code: room.code,
    phase: room.phase,
    you,
    players: room.players.map((player) => player && ({
      pet: player.pet, ready: player.ready, hp: player.hp, locked: player.move !== null,
    })),
    round: room.round,
    log: room.log.slice(-12),
    winner: room.winner,
    deadline: room.deadline,
  };
}

export function createRooms({ clock = Date.now, roundMs = 45_000, maxRooms = 256 } = {}) {
  const rooms = new Map();

  function finish(room, winner, note) {
    room.phase = 'finished';
    room.winner = winner;
    room.deadline = null;
    room.log.push(note);
  }

  function settle(room, now) {
    const [left, right] = room.players;
    const choices = [left.move, right.move];
    const [a, b] = choices;
    let note = `第 ${room.round} 回合 · ${labels[a] ?? '超时'} / ${labels[b] ?? '超时'}`;
    if (a === b) {
      note += '，平手。';
    } else {
      const winner = a && (!b || beats[a] === b) ? 0 : 1;
      room.players[1 - winner].hp -= 1;
      note += `，${room.players[winner].pet.name} 得分。`;
    }
    room.log.push(note);
    const health = room.players.map((player) => player.hp);
    if (health.includes(0) || room.round >= 9) {
      const winner = health[0] === health[1] ? 'draw' : health[0] > health[1] ? 0 : 1;
      finish(room, winner, winner === 'draw' ? '对战结束，双方平局。' : `${room.players[winner].pet.name} 获胜。`);
      return;
    }
    room.round += 1;
    room.deadline = now + roundMs;
    left.move = right.move = null;
  }

  return function handle(action, data = {}) {
    const now = clock();
    for (const [code, room] of rooms) {
      if (now - room.touched >= idleMs || (room.phase === 'waiting' && now >= room.expires)) {
        rooms.delete(code);
      }
    }
    if (action === 'create') {
      if (rooms.size >= maxRooms) throw new ArenaError(503, '房间已满，请稍后再试。');
      let code;
      do {
        code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      } while (rooms.has(code));
      const key = token();
      const room = {
        code, phase: 'waiting', players: [makePlayer(data.pet, key), null],
        round: 0, log: [], winner: null, deadline: null, touched: now, expires: now + 10 * 60_000,
      };
      rooms.set(code, room);
      return { key, room: roomView(room, 0) };
    }

    const room = rooms.get(normalizeCode(data.code));
    if (!room) throw new ArenaError(404, '房间不存在或已过期。');
    let you = room.players.findIndex((player) => player && player.key === data.key);
    if (action === 'join') {
      if (you === 1) return { key: data.key, room: roomView(room, you) };
      if (room.phase !== 'waiting' || room.players[1]) throw new ArenaError(409, '房间已满或已结束。');
      const key = typeof data.key === 'string' && /^[\w-]{32}$/.test(data.key) ? data.key : token();
      if (you === 0) throw new ArenaError(409, '你已在该房间内。');
      room.players[1] = makePlayer(data.pet, key);
      room.touched = now;
      return { key, room: roomView(room, 1) };
    }
    if (you < 0) throw new ArenaError(403, '房间凭据无效。');
    room.touched = now;
    if (room.phase === 'playing' && now >= room.deadline) settle(room, now);
    const player = room.players[you];
    switch (action) {
      case 'status':
        break;
      case 'ready':
        if (room.phase === 'waiting') {
          player.ready = true;
          if (room.players.every((entry) => entry?.ready)) {
            room.phase = 'playing';
            room.round = 1;
            room.deadline = now + roundMs;
          }
        }
        break;
      case 'move':
        if (room.phase !== 'playing' || data.round !== room.round) {
          throw new ArenaError(409, '回合已变化，请按当前回合出招。');
        }
        if (typeof data.move !== 'string' || !Object.hasOwn(beats, data.move)) throw new ArenaError(400, '招式无效。');
        if (player.move && player.move !== data.move) throw new ArenaError(409, '本回合已锁定招式。');
        player.move = data.move;
        if (room.players.every((entry) => entry.move)) settle(room, now);
        break;
      case 'leave':
        if (room.phase === 'waiting') {
          if (you === 0) {
            rooms.delete(room.code);
          } else {
            room.players[1] = null;
          }
        } else if (room.phase === 'playing') {
          finish(room, 1 - you, `${player.pet.name} 已离开对战。`);
        }
        return { room: null };
      default:
        throw new ArenaError(400, '未知房间操作。');
    }
    return { room: roomView(room, you) };
  };
}
