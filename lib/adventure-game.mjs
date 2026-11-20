import { randomUUID } from 'node:crypto';

import { initialBuild, moveError, resetFighter, resolveAction, rules, validateLoadout } from './combat.mjs';

import { ArenaError } from './rooms.mjs';

const maxRank = 3;
const foes = [
  { id: 'scout', name: '疾风斥候', stats: [2, 1, 0], pattern: ['attack', 'break', 'attack'] },
  { id: 'guard', name: '岩甲卫士', stats: [1, 3, 1], pattern: ['shield', 'attack', 'heavy'] },
  { id: 'hunter', name: '雷牙猎手', stats: [3, 1, 0], pattern: ['charge', 'heavy', 'attack'] },
];
const bosses = [
  { id: 'iron-king', name: '铁壁兽王', stats: [4, 5, 3], pattern: ['counter', 'attack', 'heavy'] },
  { id: 'ember-dragon', name: '熔火巨龙', stats: [6, 3, 4], pattern: ['charge', 'heavy', 'break', 'attack'] },
];
const upgrades = [
  ['fang', '磨砺利爪', '攻击 +2。配合重击提高爆发。', 'attack', 2],
  ['carapace', '甲片增厚', '防御 +2。配合反击承受攻势。', 'defense', 2],
  ['heart', '强韧心脏', '生命上限与当前生命 +9。配合回复留出治疗空间。', 'vitality', 3],
  ['vampire', '汲血尖牙', '主动命中后回复 1 点生命。配合普攻持续续航。'],
  ['opening', '先发制人', '每场首次行动的攻击 +3。配合先手破甲。'],
  ['pierce', '凿甲尖刺', '施放破甲时攻击 +4。配合破甲削弱高防目标。'],
  ['focus', '固有共鸣', '固有攻击的攻击 +2，施放固有技回复 1 点生命。配合所有固有技。'],
  ['bastion', '护壁修复', '施放护盾、反击或星晶壁时回复 2 点生命。配合护盾或反击稳住生命。'],
  ['battery', '储能核心', '每场初始体力 +1，上限为 5。配合重击提前爆发。'],
  ['harvest', '战后补给', '每次胜利回复 3 点生命。配合护盾维持跨关生命。'],
  ['resolve', '背水一战', '生命不超过一半时攻击 +3。配合重击低血爆发。'],
  ['tonic', '急救储备', '立刻回复 12 点生命。配合回复快速脱险。'],
];
const option = (id, name, description) => ({ id, name, description });
const rank = (run, key) => run.upgrades[key] ?? 0;
const heal = (fighter, amount) => { fighter.hp = Math.min(fighter.maxHp, fighter.hp + amount); };

function record(run, message) {
  run.log.push(message);
  if (run.log.length > 60) run.log.shift();
}

function choosePhase(run, phase, options) {
  run.phase = phase;
  run.options = options;
  run.intent = '';
}

function formOptions(forms) {
  return forms.map((form) => {
    const skill = initialBuild(form).innateSkill;
    return option(form.speciesId, form.species, `阶段 ${form.stage} · ${skill.name}：${skill.description}`);
  });
}

function changeForm(run, form, first) {
  const oldMax = run.player.maxHp;
  run.pet = { ...run.pet, combatStats: undefined, ...form, name: run.pet.name };
  const build = initialBuild(run.pet);
  Object.assign(run.player, { base: build.base, profile: build.profile, innateSkill: build.innateSkill, name: run.pet.name });
  if (first) resetFighter(run.player);
  else {
    run.player.points.attack += 2;
    run.player.points.defense += 1;
    run.player.points.vitality += 1;
    run.player.maxHp = 24 + 3 * (build.base.vitality + run.player.points.vitality);
    run.player.hp = Math.max(1, run.player.maxHp - (oldMax - run.player.hp));
  }
}

function preview(run) {
  const enemy = run.enemy;
  const proposed = enemy.pattern[enemy.actionsUsed % enemy.pattern.length];
  run.intentMove = moveError(enemy, proposed) ? 'attack' : proposed;
  run.intent = `${enemy.name}准备使用${rules.skills[run.intentMove].name}。`;
}

function enterBattle(run, elite = false) {
  const boss = !elite && run.floor % 5 === 0;
  const foe = boss ? bosses[(run.floor / 5 - 1) % bosses.length] : foes[(run.floor - 1) % foes.length];
  const growth = Math.floor((run.floor - 1) / 2) + Math.floor(run.floor / 10) + Number(elite) * 2;
  const [attack, defense, vitality] = foe.stats;
  const enemy = { id: foe.id, name: `${elite ? '精英·' : ''}${foe.name}`, boss, elite, pattern: [...foe.pattern],
    base: { attack, defense, vitality }, points: { attack: growth, defense: growth, vitality: growth },
    skills: [...new Set(foe.pattern.filter((id) => id !== 'attack'))], innateSkill: initialBuild({ species: foe.name }).innateSkill };
  resetFighter(enemy);
  run.enemy = enemy;
  run.lastActions = [];
  const hp = run.player.hp;
  resetFighter(run.player);
  run.player.hp = Math.min(hp, run.player.maxHp);
  run.player.energy = Math.min(rules.maxEnergy, 2 + rank(run, 'battery'));
  choosePhase(run, 'battle', []);
  preview(run);
  record(run, `第 ${run.floor} 关，遭遇${enemy.name}。`);
}

export function startRun(pet, roots = [], skills, points) {
  if (!pet || typeof pet.species !== 'string' || !pet.species.trim()) throw new ArenaError(400, '出战宠物资料不完整。');
  const build = initialBuild(pet);
  const loadout = validateLoadout(points === undefined ? build.points : points, skills === undefined ? build.skills : skills);
  if (!loadout) throw new ArenaError(400, `请分配 ${rules.pointBudget} 点属性，并选择两种不同的通用技能。`);
  Object.assign(build, loadout);
  const run = { floor: 1, cleared: 0, phase: 'root', scenerySeed: randomUUID(), pet: structuredClone(pet), player: build, enemy: null,
    options: [], intent: '', intentMove: null, log: [], lastBoss: null, upgrades: {}, specialization: null,
    forms: [], catalogNotice: roots.length ? '' : '未找到进化起点图鉴，将以出战形态开始冒险。' };
  if (run.catalogNotice) record(run, run.catalogNotice);
  resetFighter(run.player);
  if (roots.length > 1) {
    run.forms = structuredClone(roots);
    run.options = formOptions(run.forms);
  } else {
    changeForm(run, roots[0] ?? pet, true);
    enterBattle(run);
  }
  return run;
}

export function presentRewards(run) {
  return run.options.map((choice) => {
    const entry = upgrades.find(([id]) => id === choice.id);
    if (!entry) return choice;
    const level = rank(run, choice.id);
    const capped = level >= maxRank;
    const boundary = entry[2].indexOf('。') + 1;
    const effect = capped ? '立即回复 12 点生命。' : entry[2].slice(0, boundary);
    const note = capped ? '' : entry[2].slice(boundary);
    return { ...choice, reward: { effect, note, level, maxRank, capped } };
  });
}

function offerRewards(run) {
  const choices = [...upgrades];
  for (let i = 0; i < 3; i++) {
    const j = i + Math.floor(Math.random() * (choices.length - i));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  choosePhase(run, 'reward', choices.slice(0, 3).map((entry) => {
    const [id, name, effect] = entry;
    const level = rank(run, id);
    const description = level >= maxRank ? '已满阶，本次仅回复 12 点生命。' : `当前 ${level}/${maxRank} 阶。`;
    return option(id, name, `${effect}${description}`);
  }));
}

function nextFloor(run) {
  run.floor++;
  if (run.floor % 5 !== 0) {
    enterBattle(run);
    return;
  }
  choosePhase(run, 'route', [option('rest', '营地休息', '恢复最大生命的 25%，然后挑战首领。'),
    option('elite', '挑战精英', '先打一场额外精英战，领取一次强化，再挑战本关首领。')]);
}

function finishFight(run, successors) {
  if (run.player.hp === 0) {
    if (run.player.skills.includes('revive') && !run.player.reviveUsed) {
      run.intent = '宠物倒下了，可以使用复活继续战斗。';
      return true;
    }
    choosePhase(run, 'ended', []);
    record(run, `宠物倒下了，最高通关 ${run.cleared}。`);
    return true;
  }
  if (run.enemy.hp > 0) return false;
  if (!run.enemy.elite) run.cleared = run.floor;
  if (run.enemy.boss) {
    run.lastBoss = run.enemy.id;
    run.forms = structuredClone(successors);
  }
  heal(run.player, 3 * rank(run, 'harvest'));
  record(run, run.enemy.elite ? `击败${run.enemy.name}，领取强化后即可挑战本关首领。` : `击败${run.enemy.name}，通过第 ${run.floor} 关。`);
  offerRewards(run);
  return true;
}

function describeAction(name, event) {
  const parts = [`${name}使用${event.name}`];
  if (event.damage) parts.push(`造成 ${event.damage} 点伤害`);
  if (event.counter) parts.push(`受到 ${event.counter} 点反击伤害`);
  if (event.healing) parts.push(`回复 ${event.healing} 点生命`);
  if (event.carapacePrevented) parts.push(`对方的甲片增厚减少 ${event.carapacePrevented} 点伤害`);
  if (event.vampireHealing) parts.push(`其中汲血尖牙回复 ${event.vampireHealing} 点`);
  return `${parts.join('，')}。`;
}

function play(run, move, successors) {
  const player = run.player;
  if (typeof move !== 'string' || !['attack', ...player.skills, player.innateSkill.id].includes(move)) throw new ArenaError(400, '无效招式。');
  if ((player.hp === 0) !== (move === 'revive')) throw new ArenaError(409, '仅在倒下时可以复活。');
  const error = moveError(player, move);
  if (error) throw new ArenaError(409, error);
  const innate = move === player.innateSkill.id;
  const focus = rank(run, 'focus');
  const burst = run.specialization === 'burst' && innate;
  let bonus = innate ? 2 * focus : 0;
  if (burst) bonus += 5;
  if (!player.actionsUsed) bonus += 3 * rank(run, 'opening');
  if (move === 'break') bonus += 4 * rank(run, 'pierce');
  if (player.hp * 2 <= player.maxHp) bonus += 3 * rank(run, 'resolve');
  player.points.attack += bonus;
  const fighters = [player, run.enemy];
  const event = resolveAction(fighters, player.actionsUsed + run.enemy.actionsUsed + 1, 0, move);
  player.points.attack -= bonus;
  const hpAfterMove = player.hp;
  if (player.hp > 0) {
    if (event.damage) {
      heal(player, rank(run, 'vampire'));
      if (player.hp > hpAfterMove) event.vampireHealing = player.hp - hpAfterMove;
    }
    if (innate) heal(player, focus + (run.specialization === 'sustain' ? 5 : 0));
    if (burst && !event.damage) player.energy = Math.min(rules.maxEnergy, player.energy + 2);
    if (['shield', 'counter', 'aegis'].includes(move)) heal(player, 2 * rank(run, 'bastion'));
  }
  event.healing += player.hp - hpAfterMove;
  event.hpAfter[0] = player.hp;
  run.lastActions = [event];
  record(run, describeAction('我方', event));
  if (finishFight(run, successors)) return;
  const enemyAction = resolveAction(fighters, event.turn + 1, 1, run.intentMove, 2 * rank(run, 'carapace'));
  run.lastActions.push(enemyAction);
  record(run, describeAction(run.enemy.name, enemyAction));
  preview(run);
  finishFight(run, successors);
}

function takeReward(run, id) {
  const [, name, , stat, points] = upgrades.find(([key]) => key === id);
  if (rank(run, id) >= maxRank) {
    heal(run.player, 12);
    record(run, `${name}已满阶，转为生命补给。`);
  } else {
    run.upgrades[id] = rank(run, id) + 1;
    if (stat) run.player.points[stat] += points;
    if (stat === 'vitality') run.player.maxHp += 3 * points;
    if (stat === 'vitality' || id === 'tonic') heal(run.player, stat ? 3 * points : 12);
    record(run, `获得强化：${name}。`);
  }
  if (run.enemy.elite) enterBattle(run);
  else if (run.enemy.boss) {
    if (!run.forms.length) record(run, '图鉴中没有可进化的后继形态，可以选择或替换固有技专精。');
    choosePhase(run, 'evolve', [...formOptions(run.forms),
      option('burst', '固有技专精·爆发', '固有攻击的攻击 +5；防御型固有技改为返还 2 点体力。替换已有专精。'),
      option('sustain', '固有技专精·续航', '每次施放固有技回复 5 点生命。替换已有专精。')]);
  } else nextFloor(run);
}

export function advanceRun(run, action, value, successors = []) {
  if (run.phase === 'ended') throw new ArenaError(409, '冒险已结束。');
  if (action === 'end') {
    choosePhase(run, 'ended', []);
    record(run, `结束冒险，最高通关 ${run.cleared}。`);
  } else if (action === 'move' && run.phase === 'battle') {
    if (value === 'decline' && run.player.hp === 0) {
      choosePhase(run, 'ended', []);
      record(run, '放弃复活，冒险结束。');
    } else play(run, value, successors);
  } else if (action === 'choose' && run.options.some(({ id }) => id === value)) {
    switch (run.phase) {
      case 'root':
        changeForm(run, run.forms.find(({ speciesId }) => speciesId === value), true);
        run.forms = [];
        enterBattle(run);
        break;
      case 'reward': takeReward(run, value); break;
      case 'route':
        if (value === 'rest') heal(run.player, Math.ceil(run.player.maxHp / 4));
        enterBattle(run, value === 'elite');
        break;
      case 'evolve':
        if (value === 'burst' || value === 'sustain') {
          run.specialization = value;
          record(run, `已选择${value === 'burst' ? '爆发' : '续航'}专精。`);
        } else {
          changeForm(run, run.forms.find(({ speciesId }) => speciesId === value), false);
          record(run, `进化为${run.pet.species}。`);
        }
        run.forms = [];
        nextFloor(run);
        break;
      default: throw new ArenaError(409, '当前阶段无法选择。');
    }
  } else throw new ArenaError(409, '当前阶段不支持该操作或选项已失效。');
  return run;
}
