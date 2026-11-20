import { createAdventure } from "./adventure.js";
import { createStage } from "./stage.js";
import { moveCard, paintMoveCard } from "./cards.js";

const byId = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="arena-token"]').content;
const stage = createStage(document.querySelector("#arena .board"), token, render);
const adventure = createAdventure({ token, runAction, rerender: render, petDetails, skillDetails,
  fighterEffects, renderLoadout, setAttributeBadge, framesFor });
const ATTRIBUTES = { attack: "攻击", defense: "防御", vitality: "耐力" };
const SKILLS = ["attack", "break", "shield", "counter", "charge", "heavy", "heal", "revive"];
const EQUIPPED_COUNT = 2;
const ATTRIBUTE_LABELS = { vaccine: "疫苗", virus: "病毒", data: "数据" };
const IDLE_FRAMES = [0, 1];
const pointInputs = [...byId("point-fields").querySelectorAll("input")];
const POLL_INTERVAL = 1000;
const REQUEST_TIMEOUT = 5000;
const ACTION_RETRY_DELAY = 350;

let status = null;
let pending = false;
let version = 0;
let actionError = "";
let pollError = "";
let connection = "connecting";
let failedPolls = 0;
let checkResult = null;
let reloading = false;
let selection = null;
let thresholdPending = false;
let resumeSnapshot = false;
let savedLoadout = null;
const spriteAnimations = new Map();
const spriteFailures = new Set();
const spriteFrames = new Map();

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function message(id, text) {
  const element = byId(id);
  setText(element, text);
  element.hidden = !text;
}

function announce(text) {
  message("announcement", text);
}

function setConnection(next) {
  connection = next;
  const labels = { connecting: "正在连接", online: "已连接", offline: "正在重连" };
  const element = byId("connection");
  element.dataset.state = next;
  setText(element, labels[next]);
}

function petDetails(pet, showStats = false) {
  const stats = pet?.combatStats;
  return [pet?.species, pet?.stage != null ? `阶段 ${pet.stage}` : "",
    showStats && stats ? `图鉴力量 ${stats.strength} / 闪避 ${stats.evasion}` : ""].filter(Boolean).join(" · ");
}

function attributeLabel(attribute) {
  return ATTRIBUTE_LABELS[attribute] || "";
}

function framesFor(speciesId) {
  if (!speciesId || !/^[1-7]-\d{1,12}$/.test(speciesId)) return Promise.resolve([]);
  if (!spriteFrames.has(speciesId)) {
    const request = fetch(`/api/sprite/${encodeURIComponent(speciesId)}`, { headers: { "X-Arena-Token": token } })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => Array.isArray(data?.frames) ? data.frames : [])
      .catch(() => []);
    spriteFrames.set(speciesId, request);
  }
  return spriteFrames.get(speciesId);
}

function animateSprite(img, speciesId, key, portrait) {
  if (!img) return;
  const state = spriteAnimations.get(key);
  if (state?.speciesId === speciesId) return;
  if (state) {
    clearInterval(state.timer);
    spriteAnimations.delete(key);
  }
  img.hidden = true;
  if (!speciesId || spriteFailures.has(speciesId)) {
    if (portrait) portrait.dataset.sprite = "false";
    return;
  }
  const token = {};
  spriteAnimations.set(key, { speciesId, timer: null, token });
  framesFor(speciesId).then((frames) => {
    if (spriteAnimations.get(key)?.token !== token) return;
    const idle = IDLE_FRAMES.map((index) => frames[index]).filter(Boolean);
    if (!idle.length) {
      spriteFailures.add(speciesId);
      spriteAnimations.delete(key);
      if (portrait) portrait.dataset.sprite = "false";
      return;
    }
    if (portrait) portrait.dataset.sprite = "true";
    let index = 0;
    const paint = () => {
      img.hidden = false;
      img.src = idle[index % idle.length];
      index += 1;
    };
    paint();
    const timer = setInterval(paint, 400);
    spriteAnimations.set(key, { speciesId, timer, token });
  });
}

function setAttributeBadge(element, attribute) {
  if (!element) return;
  const label = attributeLabel(attribute);
  setText(element, label);
  element.hidden = !label;
  if (label) element.dataset.attribute = attribute;
  else delete element.dataset.attribute;
}

function careText(care) {
  if (!care) return "";
  return `饱食 ${care.satiety} · 心情 ${care.mood} · 精力 ${care.energy} · 清洁 ${care.hygiene} · 亲密 ${care.bond}`;
}

function disableAction(button, disabled) {
  if (disabled || connection === "offline") button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function renderPlayers(id, players, actions, petAvailable) {
  const list = byId(id);
  const previous = new Map([...list.children].map((row) => [row.dataset.id, row]));
  let position = list.firstElementChild;
  for (const player of players) {
    const key = String(player.id);
    let row = previous.get(key);
    if (!row) {
      row = element("li");
      row.dataset.id = key;
      const info = element("div", "player-info");
      const mini = element("img", "mini-sprite");
      mini.alt = "";
      mini.hidden = true;
      const text = element("div", "player-text");
      text.append(element("strong"), element("p"));
      info.append(mini, text);
      const controls = element("div", "player-actions");
      for (const [action, label, payloadKey, petRequired] of actions) {
        const button = element("button", "button secondary", label);
        button.type = "button";
        button.dataset.action = action;
        if (petRequired) button.dataset.petRequired = "true";
        button.addEventListener("click", () => {
          if (button.getAttribute("aria-disabled") !== "true") runAction(action, { [payloadKey]: player.id });
        });
        controls.append(button);
      }
      row.append(info, controls);
    }
    previous.delete(key);
    if (row !== position) list.insertBefore(row, position);
    position = row.nextElementSibling;
    const name = player.name || "在线玩家";
    const petName = typeof player.pet === "string" ? player.pet : player.pet?.name;
    const detail = player.pet ? [petName !== name ? petName : "", petDetails(player.pet)].filter(Boolean).join(" · ") : "未选择出战宠物";
    const pet = player.pet && typeof player.pet === "object" ? player.pet : null;
    setText(row.querySelector("strong"), name);
    const description = row.querySelector(".player-text p");
    setText(description, [detail, attributeLabel(pet?.attribute), pet?.adventureTitle].filter(Boolean).join(" · "));
    description.hidden = !description.textContent;
    const mini = row.querySelector(".mini-sprite");
    const miniKey = pet?.speciesId || "";
    if (mini.dataset.species !== miniKey) {
      mini.dataset.species = miniKey;
      mini.hidden = true;
      mini.alt = pet?.speciesId ? `${name} 的形象` : "";
      if (pet?.speciesId) {
        framesFor(pet.speciesId).then((frames) => {
          const first = frames[IDLE_FRAMES[0]] || frames.find(Boolean);
          if (mini.dataset.species !== miniKey) return;
          if (first) {
            mini.src = first;
            mini.hidden = false;
          }
        });
      } else {
        mini.removeAttribute("src");
      }
    }
    for (const button of row.querySelectorAll("button")) {
      button.setAttribute("aria-label", `${button.textContent}（${name}）`);
      disableAction(button, pending || (button.hasAttribute("data-pet-required") && !petAvailable) ||
        (button.dataset.action === "challenge" && !player.pet));
    }
  }
  for (const row of previous.values()) row.remove();
}

function renderLobby() {
  const { pet, petError, lobby, relayConfigured } = status;
  byId("pet-card").dataset.empty = String(!pet);
  setText(byId("pet-name"), pet?.name || "暂无宠物");
  message("pet-meta", petDetails(pet, true));
  const portrait = byId("pet-card").querySelector(".portrait");
  animateSprite(byId("pet-sprite"), pet?.speciesId, "lobby", portrait);
  setAttributeBadge(byId("pet-attribute"), pet?.attribute);
  message("care-stats", pet?.care ? careText(pet.care) : "");
  message("pet-notice", !pet || petError
    ? [petError, !pet ? "请先在 Magpie 选择宠物，再发起或加入对战。" : ""].filter(Boolean).join(" ")
    : "");

  const discover = byId("discover");
  setText(discover, lobby.discoverable ? "停止在线发现" : "开启在线发现");
  disableAction(discover, pending || !relayConfigured || (!pet && !lobby.discoverable));
  message("online-empty", !relayConfigured || lobby.peers.length ? "" : lobby.discoverable
    ? "正在查找在线玩家。请好友也开启在线发现。"
    : "开启在线发现后，即可查找在线玩家。");
  byId("outgoing-challenge").hidden = !lobby.challengePending;
  disableAction(byId("cancel-challenge"), pending);
  byId("invites-section").hidden = !lobby.invites.length;
  renderPlayers("peers", lobby.peers, [["challenge", "挑战", "peerId", true]], !!pet && !lobby.challengePending);
  renderPlayers("invites", lobby.invites, [
    ["accept", "接受", "inviteId", true],
    ["decline", "拒绝", "inviteId", false],
  ], !!pet);

  const codeAvailable = !!pet && relayConfigured;
  byId("join-code").disabled = !codeAvailable;
  byId("join-code").readOnly = pending || lobby.challengePending;
  disableAction(byId("create"), !codeAvailable || pending || lobby.challengePending);
  disableAction(byId("join"), !codeAvailable || pending || lobby.challengePending);
  disableAction(byId("resume"), pending);
}

function supportsRules(rules) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  return count(rules?.pointBudget) && count(rules.maxEnergy) && SKILLS.every((id) => {
    const skill = rules.skills?.[id];
    return typeof skill?.name === "string" && typeof skill.description === "string"
      && count(skill.cost) && count(skill.cooldown);
  });
}

function skillDetails(skill) {
  return `消耗 ${skill.cost} 体力 · 冷却 ${skill.cooldown} 手`;
}

function fighterEffects(fighter, rules) {
  const stance = fighter?.stance;
  return [fighter?.exposed ? "破甲" : "", fighter?.charged ? "已蓄力" : "",
    stance ? (rules?.skills[stance]?.name || fighter?.innateSkill?.name) : ""].filter(Boolean).join(" · ");
}

function renderFighter(id, fighter, phase, rules) {
  const card = byId(id);
  card.dataset.empty = String(!fighter);
  setText(card.querySelector(".fighter-name"), fighter?.pet?.name || "等待加入");
  const meta = card.querySelector(".fighter-meta");
  const details = petDetails(fighter?.pet, true);
  setText(meta, details);
  meta.hidden = !details;
  setAttributeBadge(card.querySelector(".fighter-attribute"), fighter?.pet?.attribute);
  const title = card.querySelector(".fighter-adventure-title");
  const effect = card.querySelector(".fighter-adventure-effect");
  const effectName = fighter?.pet?.adventureEffect || "";
  setText(title, fighter?.pet?.adventureTitle || "");
  title.hidden = !title.textContent;
  setText(effect, effectName ? `入场特效 · ${effectName}` : "");
  effect.hidden = !effectName;
  const aura = card.querySelector(".adventure-entry-aura");
  const effectStyle = effectName === "星辉降临" ? "starlight" : "ember";
  if (aura.dataset.effect !== effectStyle) aura.dataset.effect = effectStyle;
  aura.hidden = !effectName;

  const vitals = card.querySelector(".fighter-vitals");
  vitals.hidden = !fighter || !Number.isFinite(fighter.maxHp) || fighter.maxHp <= 0;
  if (!vitals.hidden) {
    const health = card.querySelector(".health");
    const seat = id === "fighter-self" ? status.room.you : 1 - status.room.you;
    const hp = stage.visualHp(seat, fighter.hp);
    health.max = fighter.maxHp;
    health.value = hp;
    setText(card.querySelector(".health-label"), `生命 ${hp} / ${fighter.maxHp}`);
    const energy = card.querySelector(".energy");
    energy.hidden = !rules;
    if (rules) setText(energy, `体力 ${fighter.energy} / ${rules.maxEnergy}`);
  }

  let fighterState = "";
  if (fighter && phase === "waiting") fighterState = fighter.ready ? "已准备 · 配置锁定" : "未准备";
  if (fighter && phase === "playing" && !stage.busy) {
    const room = status.room;
    const seat = id === "fighter-self" ? room.you : 1 - room.you;
    fighterState = `${seat === room.firstSeat ? "先手" : "后手"} · ${seat === room.activeSeat ? "行动中" : "等待行动"}`;
  }
  const state = card.querySelector(".fighter-state");
  setText(state, fighterState);
  state.hidden = !fighterState;
  const effects = card.querySelector(".fighter-effects");
  const activeEffects = fighterEffects(fighter, rules);
  effects.hidden = stage.busy || phase !== "playing" || !activeEffects;
  if (!effects.hidden) setText(effects, activeEffects);
}

function renderLoadout(id, fighter, rules, phase) {
  const card = byId(id);
  const profile = card.querySelector(".loadout-profile");
  profile.hidden = !fighter?.profile;
  setText(profile, fighter?.profile || "");
  const stats = card.querySelector(".loadout-stats");
  stats.hidden = !fighter;
  if (fighter) {
    if (!stats.children.length) {
      for (const label of Object.values(ATTRIBUTES)) {
        const group = element("div");
        group.append(element("dt", "", label), element("dd"));
        stats.append(group);
      }
    }
    Object.keys(ATTRIBUTES).forEach((attribute, index) => {
      const base = fighter.base[attribute];
      const added = fighter.points[attribute];
      setText(stats.children[index].lastElementChild, `${base} + ${added} = ${base + added}`);
    });
  }
  const skills = fighter?.skills.map((id) => {
    const name = rules.skills[id]?.name || id;
    const cooldown = fighter.cooldowns?.[id] ?? 0;
    return phase === "playing" && cooldown ? `${name}（冷却 ${cooldown} 手）` : name;
  });
  const innate = fighter?.innateSkill;
  const innateCooldown = fighter?.cooldowns?.[innate?.id];
  const innateText = innate ? ` · 固有技能 ${innate.name}${innateCooldown ? `（冷却 ${innateCooldown} 手）` : ""}：${innate.description}（${skillDetails(innate)}）` : "";
  setText(card.querySelector(".loadout-skills"), skills ? `已装备 ${skills.join("、")}${innateText}` : "等待对手加入");
}

const skillInputs = SKILLS.slice(1).map((id) => {
  const label = element("label", "skill-option");
  const input = element("input");
  input.type = "checkbox";
  input.value = id;
  const copy = element("span");
  copy.append(element("strong"), element("span", "skill-description"), element("small"));
  label.append(input, copy);
  byId("skill-fields").append(label);
  return { input, copy };
});

function readLoadout() {
  return {
    points: Object.fromEntries(pointInputs.map((input) => [input.name, input.valueAsNumber])),
    skills: skillInputs.filter(({ input }) => input.checked).map(({ input }) => input.value),
  };
}

function loadoutKey({ points, skills }) {
  return JSON.stringify([Object.keys(ATTRIBUTES).map((id) => points[id]), SKILLS.filter((id) => skills.includes(id))]);
}

function updateLoadoutControls(rules) {
  const draft = readLoadout();
  const validPoints = pointInputs.every((input) => input.validity.valid);
  const remaining = rules.pointBudget - Object.values(draft.points).reduce((sum, value) => sum + value, 0);
  const pointText = remaining < 0 ? `超出 ${-remaining} 点` : `剩余 ${remaining} / ${rules.pointBudget} 点`;
  setText(byId("point-summary"), validPoints ? pointText : `每项请输入 0–${rules.pointBudget} 的整数。`);
  const selected = draft.skills.length;
  setText(byId("skill-summary"), `已选 ${selected} / ${EQUIPPED_COUNT} 项${selected > EQUIPPED_COUNT ? "，请取消多选的技能" : ""}`);
  const valid = validPoints && remaining === 0 && selected === EQUIPPED_COUNT;
  disableAction(byId("save-loadout"), pending || !valid || loadoutKey(draft) === savedLoadout);
  disableAction(byId("ready"), pending || !valid);
}

function renderLoadoutForm(self, rules, phase) {
  const form = byId("loadout-form");
  form.hidden = !rules || !self || self.ready || phase !== "waiting";
  if (form.hidden) return;

  const key = loadoutKey(self);
  if (savedLoadout === null || (savedLoadout !== key && loadoutKey(readLoadout()) === savedLoadout)) {
    for (const input of pointInputs) input.value = self.points[input.name];
    for (const { input } of skillInputs) input.checked = self.skills.includes(input.value);
  }
  savedLoadout = key;
  byId("point-fields").disabled = pending;
  byId("skill-fieldset").disabled = pending;
  for (const input of pointInputs) input.max = rules.pointBudget;
  for (const { input, copy } of skillInputs) {
    const skill = rules.skills[input.value];
    setText(copy.children[0], skill.name);
    setText(copy.children[1], skill.description);
    setText(copy.children[2], skillDetails(skill));
  }
  updateLoadoutControls(rules);
}

function battleCopy(room, self, opponent) {
  if (room.phase === "waiting") {
    if (!opponent) return ["等待对手加入", status.mode === "code" ? "将对战码发给好友。" : "好友接受挑战后可开始对战。"];
    if (self?.ready) return ["等待对手准备", "双方准备后，对战自动开始。"];
    return ["准备对战", "双方准备后，对战自动开始。"];
  }
  if (stage.busy) {
    const action = room.lastAction;
    const who = action.actor === room.you ? "我方" : "对手";
    return [`第 ${action.turn} 手`, `${who} · ${action.name || room.rules.skills[action.move]?.name || (action.move === "decline" ? "放弃复活" : "超时")}`];
  }
  if (room.phase === "playing") {
    const ours = room.activeSeat === room.you;
    const detail = room.revivePending ? (ours ? "复活可恢复 30% 最大生命，放弃或超时将结束复活机会。" : "等待后手决定是否复活。") :
      (ours ? "选择一项招式。" : "等待对手出招。");
    return [`第 ${room.turn} 手 · ${ours ? "我方行动" : "对手行动"}`, selection ? "正在提交招式…" : detail];
  }
  const score = room.settlement?.[room.you];
  const signed = (value) => value > 0 ? `+${value}` : `${value}`;
  const detail = score ? `本场 ${signed(score.total)} Token（赛果 ${signed(score.resultPoints)}，超时 ${score.timeouts} 次）。` +
    (Number.isFinite(score.applied) && Number.isFinite(score.balance) ? `实际变动 ${signed(score.applied)}，余额 ${score.balance} Token。` : "等待钱包结算。") : "本场对战结束。";
  if (score?.forfeited) return ["你已认负", detail];
  if (room.settlement?.[1 - room.you]?.forfeited) return ["对手已认负", detail];
  if (room.winner === "draw") return ["平局", detail];
  if (room.winner === room.you) return ["你赢了", detail];
  if (room.winner === 0 || room.winner === 1) return ["对手获胜", detail];
  return ["对战结束", ""];
}

function updateTimer() {
  const room = status?.room;
  if (stage.busy || room?.phase !== "playing" || !Number.isFinite(room.deadline)) {
    message("timer", "");
    return;
  }
  const deadline = room.deadline < 1e12 ? room.deadline * 1000 : room.deadline;
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  message("timer", seconds ? `剩余 ${seconds} 秒` : "正在结算");
}

function renderLog(log) {
  const list = byId("battle-log");
  byId("history").hidden = !log.length;
  if (list.children.length === log.length && log.every((line, index) => list.children[index].textContent === line)) return;
  list.replaceChildren(...log.map((line) => element("li", "", line)));
}

const moveButtons = Array.from({ length: EQUIPPED_COUNT + 2 }, () => {
  const button = moveCard();
  byId("move-buttons").append(button);
  return button;
});

function renderRoundControls(room, self, rules) {
  const controls = byId("round-controls");
  controls.hidden = room.phase !== "playing" || !rules || !self;
  if (controls.hidden) return;

  const ours = room.activeSeat === room.you;
  const reviveChoice = room.revivePending && !stage.busy;
  setText(byId("moves-title"), reviveChoice ? "复活选择" : "选择招式");
  setText(byId("move-help"), `在招式区内可按数字键 ${reviveChoice ? "1–2" : "1–4"} 选择。`);
  const moves = reviveChoice ? ["revive", "decline"] : ["attack", ...self.skills, self.innateSkill?.id];
  moveButtons.forEach((button, index) => {
    const id = moves[index];
    button.hidden = !id;
    if (!id) {
      delete button.dataset.move;
      delete button.dataset.innate;
      button.removeAttribute("data-powered");
      button.removeAttribute("data-threshold");
      return;
    }
    const innate = id === self.innateSkill?.id;
    const skill = id === "decline" ? { name: "放弃复活", description: "放弃后结算胜负。", cost: 0, cooldown: 0 } :
      innate ? self.innateSkill : rules.skills[id];
    const cooldown = self.cooldowns?.[id] ?? 0;
    const selected = selection?.move === id;
    let restriction = "";
    if (id === "revive" && !reviveChoice) {
      restriction = self.reviveUsed ? "本场已使用" : room.you === room.firstSeat ? "仅开局后手可用" : "倒地时可用";
    }
    const availability = [restriction, cooldown ? `冷却 ${cooldown} 手` : "", skill.cost > self.energy ? "体力不足" : ""].filter(Boolean);
    paintMoveCard(button, { id, name: skill.name, description: skill.description,
      detail: id === "decline" ? "" : skillDetails(skill), shortcut: String(index + 1),
      innate: innate ? skill.effect || id : "", powered: innate && self.energy >= skill.cost, speciesId: self.pet?.speciesId }, framesFor);
    button.toggleAttribute("data-selected", selected);
    const state = stage.busy ? "结算中" : resumeSnapshot ? "正在同步" : selected ? "正在提交…" : ours ? "" : "对手行动";
    setText(button.lastElementChild, [state, availability.join(" · ") || (innate ? "已就绪" : "可用")].filter(Boolean).join(" · "));
    if (innate && thresholdPending && !stage.busy) {
      thresholdPending = false;
      button.setAttribute("data-threshold", "");
    }
    disableAction(button, pending || stage.busy || resumeSnapshot || !ours || !!availability.length);
  });
}

function renderArena() {
  const { room, mode } = status;
  const self = room.players[room.you];
  const opponent = room.players[1 - room.you];
  setText(byId("room-mode"), { online: "在线对战", code: "对战码房间" }[mode] || "对战房间");
  byId("room-code").hidden = mode !== "code" || room.phase !== "waiting" || !room.code;
  setText(byId("room-code-text"), room.code || "");
  setText(byId("leave"), room.phase === "playing" ? "认负（−3 Token）" : "返回大厅");
  disableAction(byId("leave"), pending);
  const rules = supportsRules(room.rules) ? room.rules : null;
  stage.update(room, rules, connection === "online" && !status.error && !resumeSnapshot);
  message("rules-notice", rules ? "" : "此房间的对战规则与当前版本不兼容。请退出房间，确认双方和中继的版本后重试。");
  renderFighter("fighter-self", self, room.phase, rules);
  renderFighter("fighter-opponent", opponent, room.phase, rules);
  byId("room-loadouts").hidden = !rules;
  if (rules) {
    renderLoadout("loadout-self", self, rules, room.phase);
    renderLoadout("loadout-opponent", opponent, rules, room.phase);
  }
  const [title, detail] = battleCopy(room, self, opponent);
  setText(byId("battle-status"), title);
  message("battle-detail", detail);
  updateTimer();

  renderLoadoutForm(self, rules, room.phase);
  renderRoundControls(room, self, rules);
  renderLog(room.log);
}

function render() {
  const onAdventure = adventure.render(status, { pending, offline: connection === "offline" });
  byId("loading").hidden = !!status;
  byId("lobby").hidden = !status || !!status.room || onAdventure;
  byId("arena").hidden = !status?.room;
  message("error", actionError);
  const serviceError = status ? pollError || status.error : "";
  message("service-error", serviceError && serviceError !== actionError ? serviceError : "");
  if (!status) {
    const connectionDetail = connection === "offline" ? "暂时无法连接，正在重试。" : "连接成功后将自动显示大厅。";
    setText(byId("loading-detail"), pollError || connectionDetail);
  } else if (status.room) {
    renderArena();
  } else {
    stage.update(null);
    if (!onAdventure) renderLobby();
  }
}

function applyStatus(next) {
  const previous = status;
  const roomChanged = previous?.room?.code !== next.room?.code || !!previous?.room !== !!next.room;
  const inviteCount = next.lobby.invites.length;
  const room = next.room;
  if (roomChanged || room?.phase !== "playing" || previous?.room?.turn !== room?.turn) selection = null;
  const fighter = room?.players[room.you];
  const innate = fighter?.innateSkill;
  const continuous = !roomChanged && !resumeSnapshot && !document.hidden && !next.error && !previous?.error &&
    previous?.room?.phase === "playing" && room?.phase === "playing" && previous.room.turn === room.turn - 1;
  if (continuous && innate && previous.room.players[room.you].energy < innate.cost && fighter.energy >= innate.cost) {
    thresholdPending = true;
  }
  if (roomChanged || room?.phase !== "playing" || !innate || fighter.energy < innate.cost || resumeSnapshot || document.hidden) {
    thresholdPending = false;
    for (const button of moveButtons) button.removeAttribute("data-threshold");
  }
  if (roomChanged) savedLoadout = null;
  const active = document.activeElement;
  status = next;
  render();
  if (roomChanged) announce("");
  const phaseChanged = previous?.room?.phase !== next.room?.phase;
  if (roomChanged || active?.closest("[hidden]") || (phaseChanged && document.activeElement === document.body)) {
    const target = next.room ? byId("arena-title") : byId(byId("adventure").hidden ? "lobby-title" : "adventure-title");
    target.focus();
  }
  if (!next.room && inviteCount > (previous?.lobby.invites.length || 0)) announce(`收到 ${inviteCount} 个挑战邀请。`);
}

class ArenaRequestError extends Error {}

async function request(path, data) {
  const headers = { "X-Arena-Token": token };
  const options = { headers, cache: "no-store" };
  if (data) {
    headers["Content-Type"] = "application/json";
    options.method = "POST";
    options.body = JSON.stringify(data);
  }
  const controller = new AbortController();
  options.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(path, options);
    if (response.status === 401) {
      const url = new URL(location.href);
      const now = Date.now();
      if (!reloading && now - Number(url.searchParams.get("reconnect")) >= REQUEST_TIMEOUT) {
        reloading = true;
        url.searchParams.set("reconnect", String(now));
        location.replace(url.href);
      }
      throw new ArenaRequestError("页面会话已失效，正在重新连接。");
    }
    const body = await response.json();
    if (!response.ok || !body?.lobby) throw new ArenaRequestError(body?.error || "对战服务暂时不可用。");
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function receiveStatus(next) {
  failedPolls = 0;
  pollError = "";
  setConnection("online");
  applyStatus(next);
  if (!document.hidden && !next.error && resumeSnapshot) {
    resumeSnapshot = false;
    render();
  }
  if (checkResult) {
    const confirmed = checkResult.action === "discover" && next.lobby.discoverable === checkResult.enabled;
    checkResult = null;
    if (!confirmed && !next.error) announce("连接已恢复，请确认刚才的操作是否生效。");
  }
}

async function poll() {
  const requestVersion = version;
  try {
    if (pending || reloading) return;
    const next = await request("/api/status");
    if (requestVersion !== version) return;
    receiveStatus(next);
  } catch (error) {
    if (requestVersion !== version || reloading || ++failedPolls < 2) return;
    pollError = error instanceof ArenaRequestError ? error.message : "";
    resumeSnapshot = true;
    setConnection("offline");
    render();
  } finally {
    setTimeout(poll, status?.room?.phase === "playing" && !document.hidden ? 300 : POLL_INTERVAL);
  }
}

async function requestAction(data) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const requestId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const payload = { ...data, requestId };
  const retryUntil = Date.now() + 10_000;
  try {
    return await request("/api/action", payload);
  } catch (error) {
    if (error instanceof ArenaRequestError) throw error;
    await new Promise((resolve) => setTimeout(resolve, ACTION_RETRY_DELAY));
    if (Date.now() >= retryUntil) throw error;
    return request("/api/action", payload);
  }
}

async function runAction(action, fields) {
  if (pending || !status || connection === "offline" || reloading) return;
  pending = true;
  version += 1;
  actionError = "";
  selection = action === "move" ? { move: fields.move } : null;
  announce("");
  render();
  try {
    const next = await requestAction({ action, ...fields });
    if (action === "adventure-move") adventure.presentMove(next, fields.value);
    receiveStatus(next);
    if (action === "join") byId("join-code").value = "";
    if (action === "resume" && !next.room && !next.error) announce("没有可恢复的对战。");
    if (action === "loadout" && !next.error) announce("已保存配置。");
  } catch (error) {
    if (error instanceof ArenaRequestError) {
      if (!reloading) actionError = error.message;
    } else {
      checkResult = { action, ...fields };
      resumeSnapshot = true;
      setConnection("offline");
    }
  } finally {
    selection = null;
    pending = false;
    render();
  }
}

function onAction(id, action, fields = () => undefined) {
  const button = byId(id);
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") !== "true") runAction(action, fields());
  });
}

onAction("discover", "discover", () => ({ enabled: !status.lobby.discoverable }));
onAction("cancel-challenge", "cancel-challenge");
onAction("create", "create");
onAction("resume", "resume");
onAction("leave", "leave", () => ({ reviewSettlement: status?.room?.phase === "playing" }));

const loadoutForm = byId("loadout-form");
loadoutForm.addEventListener("input", () => updateLoadoutControls(status.room.rules));
loadoutForm.addEventListener("submit", (event) => event.preventDefault());
onAction("save-loadout", "loadout", readLoadout);
onAction("ready", "ready", readLoadout);

function joinRoom() {
  if (byId("join").getAttribute("aria-disabled") === "true") return;
  const input = byId("join-code");
  const code = input.value.trim();
  if (!code) {
    input.setCustomValidity("请输入好友的对战码。");
    input.reportValidity();
    return;
  }
  runAction("join", { code });
}

byId("join").addEventListener("click", joinRoom);
byId("join-form").addEventListener("submit", (event) => event.preventDefault());
byId("join-code").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    joinRoom();
  }
});
byId("join-code").addEventListener("input", (event) => event.target.setCustomValidity(""));

function submitMove(button) {
  const room = status?.room;
  if (!room || room.phase !== "playing" || room.activeSeat !== room.you || stage.busy || pending || document.hidden ||
      byId("round-controls").hidden || button.hidden || button.getAttribute("aria-disabled") === "true") return;
  runAction("move", { move: button.dataset.move, turn: room.turn });
}

for (const button of moveButtons) {
  button.addEventListener("click", () => submitMove(button));
  button.addEventListener("animationend", (event) => {
    if (event.animationName === "innate-threshold") button.removeAttribute("data-threshold");
  });
}
byId("round-controls").addEventListener("keydown", (event) => {
  if (!/^[1-4]$/.test(event.key) || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  submitMove(moveButtons[Number(event.key) - 1]);
});
document.addEventListener("visibilitychange", () => {
  resumeSnapshot = true;
  thresholdPending = false;
  for (const button of moveButtons) button.removeAttribute("data-threshold");
  adventure.invalidate();
  stage.invalidate();
});

byId("copy-code").addEventListener("click", async () => {
  const code = status?.room?.code;
  if (!code) return;
  const label = byId("room-code-text");
  try {
    await navigator.clipboard.writeText(code);
    announce("已复制对战码。");
  } catch {
    if (label.textContent !== code || byId("room-code").hidden) return;
    const range = document.createRange();
    range.selectNodeContents(label);
    const textSelection = window.getSelection();
    textSelection.removeAllRanges();
    textSelection.addRange(range);
    announce("已选中对战码，请手动复制。");
  }
});

setInterval(updateTimer, 250);
poll();
