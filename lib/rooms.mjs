import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { initialBuild, maxActions, moveError, resetFighter, resolveAction, roomRules, rules, validateLoadout } from './combat.mjs';

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
  const { strength, evasion } = value.combatStats ?? {};
  const validStat = (stat) => Number.isInteger(stat) && stat >= 0 && stat <= 100;
  const combatStats = speciesId && validStat(strength) && validStat(evasion) ? { strength, evasion } : undefined;
  const attribute = ['vaccine', 'virus', 'data'].includes(value.attribute) ? value.attribute : undefined;
  return { name, species, stage: value.stage, speciesId, combatStats, attribute };
}

export function normalizeCode(code) {
  const value = typeof code === 'string' ? code.trim().toUpperCase().replace(/[ -]/g, '') : '';
  if (value.length !== 8 || [...value].some((char) => !alphabet.includes(char))) {
    throw new ArenaError(400, '请输入有效的 8 位对战码。');
  }
  return value;
}

function makePlayer(pet, key, walletId) {
  const clean = cleanPet(pet);
  const player = { pet: clean, key, walletId, ready: false, timeouts: 0, requests: new Map(), ...initialBuild(clean) };
  resetFighter(player);
  return player;
}

function roomView(room, you) {
  return {
    code: room.code, phase: room.phase, you, rules: roomRules,
    players: room.players.map((player) => player && ({
      pet: player.pet, ready: player.ready,
      profile: player.profile, base: player.base, points: player.points, skills: player.skills, innateSkill: player.innateSkill,
      hp: player.hp, maxHp: player.maxHp, energy: player.energy, maxEnergy: rules.maxEnergy, cooldowns: { ...player.cooldowns },
      exposed: player.exposed, charged: player.charged, stance: player.stance, reviveUsed: player.reviveUsed,
      actionsUsed: player.actionsUsed,
    })),
    turn: room.turn, activeSeat: room.activeSeat, firstSeat: room.firstSeat, revivePending: room.revivePending,
    lastAction: room.lastAction, log: room.log.slice(-12), winner: room.winner, settlement: room.settlement,
    deadline: room.deadline,
  };
}

function finish(room, winner, note, forfeited = null) {
  room.phase = 'finished';
  room.winner = winner;
  room.activeSeat = null;
  room.deadline = null;
  room.revivePending = false;
  room.log.push(note);
  room.awards = room.players.map((player, index) => {
    const result = index === forfeited ? -3 : winner === 'draw' ? 1 : winner === index ? 3 : -1;
    return {
      walletId: player.walletId, timeouts: player.timeouts, forfeited: index === forfeited,
      resultPoints: result > 0 && !player.requests.size ? 0 : result,
    };
  });
}

function finishByHp(room) {
  const [left, right] = room.players;
  const difference = left.hp * right.maxHp - right.hp * left.maxHp;
  const winner = difference === 0 ? 'draw' : difference > 0 ? 0 : 1;
  finish(room, winner, winner === 'draw' ? '对战结束，双方平局。' : `${room.players[winner].pet.name} 获胜。`);
}

export function createRooms({ clock = Date.now, turnMs = 60_000, maxRooms = 256, chooseFirst = () => randomInt(2), wallet } = {}) {
  const rooms = new Map();

  function identity(key) {
    if (!wallet) throw new ArenaError(503, 'Token 服务暂时不可用。');
    const id = wallet.identity(key);
    if (typeof id !== 'string' || !id) throw new ArenaError(403, '钱包凭据无效。');
    return id;
  }

  function postAwards(room) {
    // A failed write leaves the exact terminal decision available for a retry with the same match ID.
    if (room.awards && !room.settlement) room.settlement = wallet.settle(room.matchId, room.awards);
  }

  function beginTurn(room, seat, now) {
    room.turn++;
    room.activeSeat = seat;
    room.deadline = now + turnMs;
  }

  function play(room, move, now) {
    const actor = room.activeSeat;
    const player = room.players[actor];
    const revivalChoice = room.revivePending;
    const event = resolveAction(room.players, room.turn, actor, move);
    if (move === 'timeout') player.timeouts++;
    room.lastAction = event;
    const label = event.name ?? (move === 'decline' ? '放弃复活' : '超时');
    const details = [`第 ${room.turn} 手 · ${player.pet.name} · ${label}`];
    if (event.damage) details.push(`伤害 ${event.damage}`);
    if (event.counter) details.push(`反击 ${event.counter}`);
    if (event.healing) details.push(`回复 ${event.healing}`);
    if (event.penalty) details.push(`扣 ${event.penalty} 生命`);
    room.log.push(details.join('，'));
    room.revivePending = false;

    const second = 1 - room.firstSeat;
    const candidate = room.players[second];
    if (!revivalChoice && candidate.hp === 0 && candidate.skills.includes('revive') &&
        !candidate.reviveUsed && candidate.actionsUsed < maxActions) {
      room.revivePending = true;
      beginTurn(room, second, now);
      return;
    }
    if (room.players.some((entry) => entry.hp === 0) || room.players.every((entry) => entry.actionsUsed >= maxActions)) {
      finishByHp(room);
      return;
    }
    const next = 1 - actor;
    beginTurn(room, room.players[next].actionsUsed < maxActions ? next : actor, now);
  }

  function expireTurns(room, now) {
    while (room.phase === 'playing' && now >= room.deadline) play(room, 'timeout', room.deadline);
  }

  return function handle(action, data = {}) {
    const now = clock();
    for (const [code, room] of rooms) {
      if (room.phase === 'waiting' && now >= room.expires) rooms.delete(code);
      else if (now - room.touched >= idleMs) {
        expireTurns(room, now);
        if (room.phase === 'playing') continue;
        if (room.awards && !room.settlement) {
          try { postAwards(room); } catch { continue; }
          room.touched = now;
        } else rooms.delete(code);
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
        code, matchId: randomUUID(), phase: 'waiting', players: [makePlayer(data.pet, key, identity(data.walletKey)), null],
        turn: 0, activeSeat: null, firstSeat: null, revivePending: false, lastAction: null, settlement: null,
        log: [], winner: null, deadline: null, touched: now, expires: now + 10 * 60_000,
      };
      rooms.set(code, room);
      return { key, room: roomView(room, 0) };
    }

    const room = rooms.get(normalizeCode(data.code));
    if (!room) throw new ArenaError(404, '房间不存在或已过期。');
    const you = room.players.findIndex((player) => player && player.key === data.key);
    if (action === 'join') {
      const walletId = identity(data.walletKey);
      if (you === 1 && room.players[1].walletId === walletId) {
        expireTurns(room, now);
        postAwards(room);
        return { key: data.key, room: roomView(room, you) };
      }
      if (room.phase !== 'waiting' || room.players[1]) throw new ArenaError(409, '房间已满或已结束。');
      if (you === 0 || walletId === room.players[0].walletId) throw new ArenaError(409, '你已在该房间内。');
      const key = typeof data.key === 'string' && /^[\w-]{32}$/.test(data.key) ? data.key : token();
      room.players[1] = makePlayer(data.pet, key, walletId);
      room.touched = now;
      return { key, room: roomView(room, 1) };
    }
    if (you < 0) throw new ArenaError(403, '房间凭据无效。');
    room.touched = now;
    expireTurns(room, now);
    postAwards(room);
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
            room.firstSeat = chooseFirst();
            beginTurn(room, room.firstSeat, now);
          }
        }
        break;
      case 'move': {
        if (typeof data.requestId !== 'string' || !data.requestId.trim() || data.requestId.length > 128) {
          throw new ArenaError(400, '出招请求标识无效。');
        }
        const previous = player.requests.get(data.requestId);
        if (previous) {
          if (previous.turn !== data.turn || previous.move !== data.move) throw new ArenaError(409, '出招请求标识已使用。');
          break;
        }
        if (room.phase !== 'playing' || data.turn !== room.turn || you !== room.activeSeat) {
          throw new ArenaError(409, '行动权已变化，请按当前行动出招。');
        }
        if (room.revivePending) {
          if (!['revive', 'decline'].includes(data.move)) throw new ArenaError(409, '请选择复活或放弃。');
        } else {
          if (typeof data.move !== 'string' || data.move === 'revive' ||
              (!Object.hasOwn(rules.skills, data.move) && data.move !== player.innateSkill.id)) {
            throw new ArenaError(400, '招式无效。');
          }
          const problem = moveError(player, data.move);
          if (problem) throw new ArenaError(409, problem);
        }
        player.requests.set(data.requestId, { turn: data.turn, move: data.move });
        play(room, data.move, now);
        postAwards(room);
        break;
      }
      case 'leave':
        if (room.phase === 'waiting') {
          if (you === 0) rooms.delete(room.code);
          else room.players[1] = null;
        } else if (room.phase === 'playing') {
          finish(room, 1 - you, `${player.pet.name} 已离开对战。`, you);
          postAwards(room);
        }
        if (data.reviewSettlement === true && room.phase === 'finished') return { room: roomView(room, you) };
        return { room: null };
      default:
        throw new ArenaError(400, '未知房间操作。');
    }
    return { room: roomView(room, you) };
  };
}
