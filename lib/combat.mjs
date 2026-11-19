const attributes = ['attack', 'defense', 'vitality'];
const profiles = [
  { profile: '强攻型', base: { attack: 6, defense: 3, vitality: 3 } },
  { profile: '坚守型', base: { attack: 3, defense: 6, vitality: 3 } },
  { profile: '耐力型', base: { attack: 3, defense: 3, vitality: 6 } },
];

const innateSkills = [
  { id: 'flare', name: '燎原爪', description: '攻击对手，基础伤害增加 4 点。' },
  { id: 'tide', name: '汲潮歌', description: '攻击对手，并回复招式伤害的一半生命，向上取整，最多 4 点。' },
  { id: 'aegis', name: '星晶壁', description: '对手下一手的招式伤害降至四分之一，下次主动攻击额外造成 3 点伤害。' },
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

export const maxActions = 12;
export const rules = {
  pointBudget: 6,
  maxEnergy: 5,
  maxActions,
  skills: {
    attack: { name: '普攻', description: '造成基础伤害，回复 1 点体力。', cost: 0, cooldown: 0 },
    break: { name: '破甲', description: '造成伤害，本次无视一半防御。目标防御降低 3 点，持续至自己下一手结束。', cost: 1, cooldown: 1 },
    shield: { name: '护盾', description: '对手下一手的招式伤害减半，并回复 1 点体力。', cost: 0, cooldown: 1 },
    counter: { name: '反击', description: '对手下一手攻击时，减轻三分之一的伤害并反击。', cost: 1, cooldown: 1 },
    charge: { name: '蓄力', description: '回复 3 点体力。下次主动攻击额外造成 3 点伤害。', cost: 0, cooldown: 1 },
    revive: { name: '复活', description: '开局后手倒下时可消耗一手，回复 30% 最大生命（向上取整），每场限一次。', cost: 0, cooldown: 0 },
    heavy: { name: '重击', description: '造成 1.65 倍的基础伤害。', cost: 3, cooldown: 2 },
    heal: { name: '回复', description: '恢复 8 点生命，结算后最多恢复至生命上限。', cost: 2, cooldown: 2 },
  },
};

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
  player.stance = null;
  player.reviveUsed = false;
  player.actionsUsed = 0;
}

export function moveError(player, move) {
  const innate = move === player.innateSkill?.id;
  if (!innate && move !== 'attack' && !player.skills.includes(move)) return '这只宠物未装备该技能。';
  if (player.cooldowns[move]) return '该技能尚在冷却。';
  const skill = innate ? player.innateSkill : rules.skills[move];
  if (player.energy < skill.cost) return '体力不足。';
  return null;
}

function damage(attacker, defender, move) {
  if (!['attack', 'heavy', 'break', 'flare', 'tide'].includes(move)) return 0;
  let defense = Math.max(0, stat(defender, 'defense') - (defender.exposed ? 3 : 0));
  if (move === 'break') defense = Math.floor(defense / 2);
  const power = 7 + stat(attacker, 'attack') - defense + (attacker.charged ? 3 : 0);
  const mitigation = { shield: 0.5, counter: 2 / 3, aegis: 0.25 }[defender.stance] ?? 1;
  const base = Math.max(3, power) + (move === 'flare' ? 4 : 0);
  return Math.max(1, Math.round(base * (move === 'heavy' ? 1.65 : 1) * mitigation));
}

export function resolveAction(players, turn, actor, move) {
  const player = players[actor];
  const opponent = players[1 - actor];
  const skill = move === player.innateSkill.id ? player.innateSkill : rules.skills[move];
  const hpBefore = players.map(({ hp }) => hp);
  const hit = damage(player, opponent, move);
  const counter = hit && opponent.stance === 'counter' ? 3 + Math.floor(stat(opponent, 'attack') / 2) : 0;
  const penalty = move === 'timeout' ? Math.min(5, player.hp) : 0;
  let recovery = 0;
  if (move === 'revive') {
    recovery = Math.ceil(player.maxHp * 0.3);
    player.reviveUsed = true;
  } else if (move === 'heal') recovery = 8;
  else if (move === 'tide') recovery = Math.min(4, Math.ceil(hit / 2));
  const healing = Math.min(recovery, player.maxHp - player.hp + counter);
  opponent.hp = Math.max(0, opponent.hp - hit);
  player.hp = Math.max(0, player.hp + healing - counter - penalty);

  opponent.stance = null;
  opponent.exposed = move === 'break';
  if (hit) player.charged = false;
  if (move === 'charge' || move === 'aegis') player.charged = true;
  if (['shield', 'counter', 'aegis'].includes(move)) player.stance = move;
  const gain = move === 'charge' ? 3 : ['attack', 'shield'].includes(move) ? 1 : 0;
  player.energy = Math.min(rules.maxEnergy, player.energy + gain - (skill?.cost ?? 0));
  for (const key of Object.keys(player.cooldowns)) {
    if (--player.cooldowns[key] === 0) delete player.cooldowns[key];
  }
  if (skill?.cooldown) player.cooldowns[move] = skill.cooldown;
  player.actionsUsed++;
  const event = { turn, actor, move, hpBefore, hpAfter: players.map(({ hp }) => hp), damage: hit, counter, healing, penalty };
  if (skill) event.name = skill.name;
  if (skill?.effect) event.effect = skill.effect;
  return event;
}
