import { randomBytes, randomInt } from 'node:crypto';
import { initialBuild, maxRounds, moveError, resetFighter, resolveMoves, rules, validateLoadout } from './combat.mjs';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
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
  const speciesId = typeof value.speciesId === 'string' && /^[1-7]-\d{1,12}$/.test(value.speciesId)
    ? value.speciesId : undefined;
  const sprite = typeof value.sprite === 'string' && /^[A-Za-z0-9 .()_-]{1,80}$/.test(value.sprite)
    ? value.sprite : undefined;
  const attribute = ['vaccine', 'virus', 'data'].includes(value.attribute) ? value.attribute : undefined;
  return { name, species, stage: value.stage, speciesId, sprite, attribute };
}

export function normalizeCode(code) {
  const value = typeof code === 'string' ? code.trim().toUpperCase().replace(/[ -]/g, '') : '';
  if (value.length !== 8 || [...value].some((char) => !alphabet.includes(char))) {
    throw new ArenaError(400, '请输入有效的 8 位对战码。');
  }
  return value;
}

function makePlayer(pet, key) {
  const clean = cleanPet(pet);
  const player = { pet: clean, key, ready: false, move: null, ...initialBuild(clean) };
  resetFighter(player);
  return player;
}

function roomView(room, you) {
  return {
    code: room.code,
    phase: room.phase,
    you,
    rules,
    players: room.players.map((player) => player && ({
      pet: player.pet, ready: player.ready, locked: player.move !== null,
      profile: player.profile, base: player.base, points: player.points, skills: player.skills,
      hp: player.hp, maxHp: player.maxHp, energy: player.energy, cooldowns: { ...player.cooldowns },
      exposed: player.exposed, charged: player.charged,
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
    room.log.push(resolveMoves(room.players, room.round));
    left.move = right.move = null;
    if (left.hp === 0 || right.hp === 0 || room.round >= maxRounds) {
      const difference = left.hp * right.maxHp - right.hp * left.maxHp;
      const winner = difference === 0 ? 'draw' : difference > 0 ? 0 : 1;
      finish(room, winner, winner === 'draw' ? '对战结束，双方平局。' : `${room.players[winner].pet.name} 获胜。`);
      return;
    }
    room.round += 1;
    room.deadline = now + roundMs;
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
      case 'loadout':
      case 'ready':
        if (action === 'ready' && player.ready) break;
        if (action === 'loadout' || data.points !== undefined || data.skills !== undefined) {
          if (room.phase !== 'waiting' || player.ready) throw new ArenaError(409, '配装已锁定。');
          const loadout = validateLoadout(data.points, data.skills);
          if (!loadout) throw new ArenaError(400, '请分完 6 点属性，并选择两个不同的技能。');
          Object.assign(player, loadout);
          resetFighter(player);
        }
        if (action === 'ready' && room.phase === 'waiting') {
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
        if (typeof data.move !== 'string' || !Object.hasOwn(rules.skills, data.move)) throw new ArenaError(400, '招式无效。');
        if (player.move && player.move !== data.move) throw new ArenaError(409, '本回合已锁定招式。');
        const problem = moveError(player, data.move);
        if (problem) throw new ArenaError(409, problem);
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
