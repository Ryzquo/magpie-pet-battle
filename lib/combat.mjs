const attributes = ['attack', 'defense', 'vitality'];
const profiles = [
  { profile: '强攻型', base: { attack: 6, defense: 3, vitality: 3 } },
  { profile: '坚守型', base: { attack: 3, defense: 6, vitality: 3 } },
  { profile: '耐力型', base: { attack: 3, defense: 3, vitality: 6 } },
];

export const maxRounds = 12;
export const rules = {
  pointBudget: 6,
  maxEnergy: 5,
  skills: {
    attack: { name: '普攻', description: '造成基础伤害，回复 1 点能量。', cost: 0, cooldown: 0 },
    break: { name: '破甲', description: '造成伤害，本次无视一半防御，下一回合降低目标 3 点防御。', cost: 1, cooldown: 1 },
    shield: { name: '护盾', description: '本回合受到的招式伤害减半，并回复 1 点能量。', cost: 0, cooldown: 1 },
    counter: { name: '反击', description: '本回合受到招式攻击时，减轻三分之一的伤害并反击。', cost: 1, cooldown: 1 },
    charge: { name: '蓄力', description: '回复 3 点能量。下一回合的攻击额外造成 3 点伤害。', cost: 0, cooldown: 1 },
    heavy: { name: '重击', description: '造成 1.65 倍的基础伤害。', cost: 3, cooldown: 2 },
    heal: { name: '回复', description: '恢复 8 点生命，结算后最多恢复至生命上限。', cost: 2, cooldown: 2 },
  },
};

export function initialBuild(pet) {
  // Use the catalog ID when available so localized species names give the same profile.
  const species = pet.speciesId ?? pet.species;
  const hash = [...species].reduce((value, char) => ((value * 31) + char.codePointAt(0)) >>> 0, 0);
  const { profile, base } = profiles[hash % profiles.length];
  return { profile, base, points: { attack: 2, defense: 2, vitality: 2 }, skills: ['break', 'shield'] };
}

export function validateLoadout(points, skills) {
  if (!points || attributes.some((key) => !Number.isInteger(points[key]) || points[key] < 0) ||
      attributes.reduce((sum, key) => sum + points[key], 0) !== rules.pointBudget ||
      !Array.isArray(skills) || skills.length !== 2 || skills[0] === skills[1] ||
      skills.some((key) => typeof key !== 'string' || key === 'attack' || !Object.hasOwn(rules.skills, key))) return null;
  return { points: Object.fromEntries(attributes.map((key) => [key, points[key]])), skills: [...skills] };
}

const stat = (player, key) => player.base[key] + player.points[key];

export function resetFighter(player) {
  player.maxHp = 24 + 3 * stat(player, 'vitality');
  player.hp = player.maxHp;
  player.energy = 2;
  player.cooldowns = {};
  player.exposed = false;
  player.charged = false;
}

export function moveError(player, move) {
  if (move !== 'attack' && !player.skills.includes(move)) return '这只宠物未装备该技能。';
  if (player.cooldowns[move]) return '该技能尚在冷却。';
  if (player.energy < rules.skills[move].cost) return '能量不足。';
  return null;
}

function damage(attacker, defender) {
  const move = attacker.move;
  if (!['attack', 'heavy', 'break'].includes(move)) return 0;
  let defense = Math.max(0, stat(defender, 'defense') - (defender.exposed ? 3 : 0));
  if (move === 'break') defense = Math.floor(defense / 2);
  const power = 7 + stat(attacker, 'attack') - defense + (attacker.charged ? 3 : 0);
  const mitigation = defender.move === 'shield' ? 0.5 : defender.move === 'counter' ? 2 / 3 : 1;
  return Math.max(1, Math.round(Math.max(3, power) * (move === 'heavy' ? 1.65 : 1) * mitigation));
}

export function resolveMoves(players, round) {
  const incoming = players.map((defender, index) => damage(players[1 - index], defender));
  const hit = [...incoming];
  for (const [index, player] of players.entries()) {
    if (player.move === 'counter' && incoming[index] > 0) {
      hit[1 - index] += 3 + Math.floor(stat(player, 'attack') / 2) + (player.charged ? 3 : 0);
    }
  }
  const reports = players.map((player, index) => {
    const move = player.move;
    const skill = rules.skills[move];
    const healing = move === 'heal' ? Math.min(8, player.maxHp - player.hp + hit[index]) : 0;
    const penalty = !move && players[1 - index].move ? 5 : 0;
    player.hp = Math.max(0, Math.min(player.maxHp, player.hp + healing - hit[index] - penalty));
    const gain = move === 'charge' ? 3 : ['attack', 'shield'].includes(move) ? 1 : 0;
    const beforeEnergy = player.energy;
    player.energy = Math.min(rules.maxEnergy, beforeEnergy + gain - (skill?.cost ?? 0));
    for (const key of Object.keys(player.cooldowns)) {
      if (--player.cooldowns[key] === 0) delete player.cooldowns[key];
    }
    if (skill?.cooldown) player.cooldowns[move] = skill.cooldown;
    player.exposed = players[1 - index].move === 'break';
    player.charged = move === 'charge';
    const details = [`${player.pet.name} · ${skill?.name ?? '超时'}`];
    if (hit[index]) details.push(`受伤 ${hit[index]}`);
    if (healing) details.push(`回复 ${healing}`);
    if (penalty) details.push(`超时扣 ${penalty} 生命`);
    if (player.energy !== beforeEnergy) details.push(`能量 ${beforeEnergy} → ${player.energy}`);
    return details.join('，');
  });
  return `第 ${round} 回合 · ${reports.join(' / ')}`;
}
