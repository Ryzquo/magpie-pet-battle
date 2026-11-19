const attributes = ['attack', 'defense', 'vitality'];
const profiles = [
  { profile: '强攻型', base: { attack: 6, defense: 3, vitality: 3 } },
  { profile: '坚守型', base: { attack: 3, defense: 6, vitality: 3 } },
  { profile: '耐力型', base: { attack: 3, defense: 3, vitality: 6 } },
];

const innateSkills = [
  { id: 'flare', name: '燎原爪', description: '攻击对手，基础伤害增加 4 点。' },
  { id: 'tide', name: '汲潮歌', description: '攻击对手，并回复招式伤害的一半生命，向上取整，最多 4 点。' },
  { id: 'aegis', name: '星晶壁', description: '本回合受到的招式伤害降至四分之一，下一回合攻击额外造成 3 点伤害。' },
].map((skill) => ({ ...skill, cost: 2, cooldown: 2 }));
const innateById = Object.fromEntries(innateSkills.map((skill) => [skill.id, skill]));

// IDs follow the installed @jcendal/opencode-digital-pet 0.18.0 catalog.
const catalogSkills = new Map([
  ['3-001', { id: 'flare', name: '小型火焰' }], // Agumon
  ['3-008', { id: 'flare', name: '魔法火焰', effect: 'magic-flame' }], // Biyomon
  ['3-022', { id: 'flare', name: '爆炎火焰弹', effect: 'blue-flame' }], // Gabumon
  ['3-029', { id: 'tide', name: '鱼群大暴走' }], // Gomamon
  ['3-056', { id: 'aegis', name: '毒蔓护壁', effect: 'ivy' }], // Palmon
  ['3-058', { id: 'flare', name: '空气炮', effect: 'gust' }], // Patamon
  ['3-073', { id: 'flare', name: '飞翼闪电', effect: 'spark' }], // Tentomon
]);

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

// Older clients look up the name of every settled move in the shared rule table.
export const roomRules = { ...rules, skills: { ...rules.skills, ...innateById } };

function catalogBuild({ strength, evasion }) {
  const weights = [strength, evasion, 50];
  const total = strength + evasion + 50;
  const weightedPoints = weights.map((weight) => weight * 6);
  const allocation = weightedPoints.map((points) => Math.floor(points / total));
  const remainderOrder = attributes.map((_, index) => index)
    .sort((left, right) => weightedPoints[right] % total - weightedPoints[left] % total);
  const remaining = 6 - allocation.reduce((sum, points) => sum + points, 0);
  for (const index of remainderOrder.slice(0, remaining)) allocation[index]++;
  const base = Object.fromEntries(attributes.map((name, index) => [name, 2 + allocation[index]]));
  const peak = Math.max(...allocation);
  const profile = allocation.filter((points) => points === peak).length === 1
    ? profiles[allocation.indexOf(peak)].profile : '均衡型';
  return { profile, base };
}

export function initialBuild(pet) {
  const species = pet.speciesId ?? pet.species;
  const hash = [...species].reduce((value, char) => ((value * 31) + char.codePointAt(0)) >>> 0, 0);
  const { profile, base } = pet.combatStats ? catalogBuild(pet.combatStats) : profiles[hash % profiles.length];
  const catalogSkill = catalogSkills.get(species);
  const innate = innateSkills[hash % innateSkills.length];
  const innateSkill = catalogSkill ? { ...innateById[catalogSkill.id], ...catalogSkill }
    : { ...innate, name: `${pet.species}·${innate.name}` };
  return { profile, base, points: { attack: 2, defense: 2, vitality: 2 }, skills: ['break', 'shield'], innateSkill };
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
  const innate = move === player.innateSkill?.id;
  if (!innate && move !== 'attack' && !player.skills.includes(move)) return '这只宠物未装备该技能。';
  if (player.cooldowns[move]) return '该技能尚在冷却。';
  const skill = innate ? player.innateSkill : rules.skills[move];
  if (player.energy < skill.cost) return '能量不足。';
  return null;
}

function damage(attacker, defender) {
  const move = attacker.move;
  if (!['attack', 'heavy', 'break', 'flare', 'tide'].includes(move)) return 0;
  let defense = Math.max(0, stat(defender, 'defense') - (defender.exposed ? 3 : 0));
  if (move === 'break') defense = Math.floor(defense / 2);
  const power = 7 + stat(attacker, 'attack') - defense + (attacker.charged ? 3 : 0);
  const mitigation = { shield: 0.5, counter: 2 / 3, aegis: 0.25 }[defender.move] ?? 1;
  const base = Math.max(3, power) + (move === 'flare' ? 4 : 0);
  return Math.max(1, Math.round(base * (move === 'heavy' ? 1.65 : 1) * mitigation));
}

export function resolveMoves(players, round) {
  const incoming = players.map((defender, index) => damage(players[1 - index], defender));
  const counters = players.map((player, index) => player.move === 'counter' && incoming[index] > 0
    ? 3 + Math.floor(stat(player, 'attack') / 2) + (player.charged ? 3 : 0) : 0);
  const actions = [];
  const reports = players.map((player, index) => {
    const move = player.move;
    const innate = move === player.innateSkill?.id;
    const skill = innate ? player.innateSkill : rules.skills[move];
    const damage = incoming[index] + counters[1 - index];
    const hpBefore = player.hp;
    const recovery = move === 'tide' ? Math.min(4, Math.ceil(incoming[1 - index] / 2)) : move === 'heal' ? 8 : 0;
    const healing = Math.min(recovery, player.maxHp - hpBefore + damage);
    const penalty = !move && players[1 - index].move ? 5 : 0;
    player.hp = Math.max(0, Math.min(player.maxHp, hpBefore + healing - damage - penalty));
    const action = { move, damage, healing, penalty, hpBefore, hp: player.hp, counter: counters[index] };
    if (innate) {
      action.name = skill.name;
      if (skill.effect) action.effect = skill.effect;
    }
    actions.push(action);
    const gain = move === 'charge' ? 3 : ['attack', 'shield'].includes(move) ? 1 : 0;
    const beforeEnergy = player.energy;
    player.energy = Math.min(rules.maxEnergy, beforeEnergy + gain - (skill?.cost ?? 0));
    for (const key of Object.keys(player.cooldowns)) {
      if (--player.cooldowns[key] === 0) delete player.cooldowns[key];
    }
    if (skill?.cooldown) player.cooldowns[move] = skill.cooldown;
    player.exposed = players[1 - index].move === 'break';
    player.charged = move === 'charge' || move === 'aegis';
    const details = [`${player.pet.name} · ${skill?.name ?? '超时'}`];
    if (damage) details.push(`受伤 ${damage}`);
    if (healing) details.push(`回复 ${healing}`);
    if (penalty) details.push(`超时扣 ${penalty} 生命`);
    if (player.energy !== beforeEnergy) details.push(`能量 ${beforeEnergy} → ${player.energy}`);
    return details.join('，');
  });
  return { round, actions, report: `第 ${round} 回合 · ${reports.join(' / ')}` };
}
