import { createStage } from "./stage.js";

const byId = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="arena-token"]').content;
const stage = createStage(document.querySelector(".board"), token);
const ATTRIBUTES = { attack: "攻击", defense: "防御", vitality: "体力" };
const SKILLS = ["attack", "break", "shield", "counter", "charge", "heavy", "heal"];
const EQUIPPED_COUNT = 2;
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
let savedLoadout = null;

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
      info.append(element("strong"), element("p"));
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
    setText(row.querySelector("strong"), name);
    const description = row.querySelector(".player-info p");
    setText(description, detail);
    description.hidden = !detail;
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
  return `消耗 ${skill.cost} 能量 · 冷却 ${skill.cooldown} 回合`;
}

function renderFighter(id, fighter, phase, rules) {
  const card = byId(id);
  card.dataset.empty = String(!fighter);
  setText(card.querySelector(".fighter-name"), fighter?.pet?.name || "等待加入");
  const meta = card.querySelector(".fighter-meta");
  const details = petDetails(fighter?.pet, true);
  setText(meta, details);
  meta.hidden = !details;

  const vitals = card.querySelector(".fighter-vitals");
  vitals.hidden = !fighter || !Number.isFinite(fighter.maxHp) || fighter.maxHp <= 0;
  if (!vitals.hidden) {
    const health = card.querySelector(".health");
    const hp = stage.visualHp(id === "fighter-self" ? "self" : "opponent", fighter.hp);
    health.max = fighter.maxHp;
    health.value = hp;
    setText(card.querySelector(".health-label"), `生命 ${hp} / ${fighter.maxHp}`);
    const energy = card.querySelector(".energy");
    energy.hidden = !rules;
    if (rules) setText(energy, `能量 ${fighter.energy} / ${rules.maxEnergy}`);
  }

  let fighterState = "";
  if (fighter && phase === "waiting") fighterState = fighter.ready ? "已准备 · 配置锁定" : "未准备";
  if (fighter && phase === "playing") fighterState = fighter.locked ? "已锁定招式" : "正在选择";
  const state = card.querySelector(".fighter-state");
  setText(state, fighterState);
  state.hidden = !fighterState;
  const effects = card.querySelector(".fighter-effects");
  const activeEffects = [fighter?.exposed ? "防御 −3" : "", fighter?.charged ? "攻击伤害 +3" : ""].filter(Boolean);
  effects.hidden = phase !== "playing" || !activeEffects.length;
  if (!effects.hidden) setText(effects, `本回合 ${activeEffects.join(" · ")}`);
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
    return phase === "playing" && cooldown ? `${name}（冷却 ${cooldown} 回合）` : name;
  });
  setText(card.querySelector(".loadout-skills"), skills ? `已装备 ${skills.join("、")}` : "等待对手加入");
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
  if (room.phase === "playing") {
    if (self?.locked) return [`第 ${room.round} 回合`, "招式已锁定，等待回合结算。"];
    return [`第 ${room.round} 回合`, "选定后将锁定招式。"];
  }
  if (room.winner === "draw") return ["平局", "本场对战结束。"];
  if (room.winner === room.you) return ["你赢了", "本场对战结束。"];
  if (room.winner === 0 || room.winner === 1) return ["对手获胜", "本场对战结束。"];
  return ["对战结束", ""];
}

function updateTimer() {
  const room = status?.room;
  if (room?.phase !== "playing" || !Number.isFinite(room.deadline)) {
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

const moveButtons = Array.from({ length: EQUIPPED_COUNT + 1 }, () => {
  const button = element("button", "move");
  button.type = "button";
  button.append(element("strong"), element("span", "skill-description"), element("small"), element("small", "move-state"));
  byId("move-buttons").append(button);
  return button;
});

function renderRoundControls(room, self, rules) {
  const controls = byId("round-controls");
  controls.hidden = room.phase !== "playing" || !rules || !self;
  if (controls.hidden) return;

  const moves = ["attack", ...self.skills];
  moveButtons.forEach((button, index) => {
    const id = moves[index];
    const skill = rules.skills[id];
    const cooldown = self.cooldowns?.[id] ?? 0;
    const selected = selection?.move === id;
    const needsEnergy = skill.cost > self.energy;
    const selectedLabel = selected ? "已锁定此招式" : "招式已锁定";
    const availability = [cooldown ? `剩余冷却 ${cooldown} 回合` : "", needsEnergy ? "能量不足" : ""]
      .filter(Boolean).join(" · ");
    button.dataset.move = id;
    button.toggleAttribute("data-selected", selected);
    setText(button.children[0], skill.name);
    setText(button.children[1], skill.description);
    setText(button.children[2], skillDetails(skill));
    setText(button.children[3], self.locked ? selectedLabel : availability || "可用");
    disableAction(button, pending || self.locked || !!availability);
  });
}

function renderArena() {
  const { room, mode } = status;
  const self = room.players[room.you];
  const opponent = room.players[1 - room.you];
  setText(byId("room-mode"), { online: "在线对战", code: "对战码房间" }[mode] || "对战房间");
  byId("room-code").hidden = mode !== "code" || room.phase !== "waiting" || !room.code;
  setText(byId("room-code-text"), room.code || "");
  setText(byId("leave"), room.phase === "playing" ? "退出对战" : "返回大厅");
  disableAction(byId("leave"), pending);
  const rules = supportsRules(room.rules) ? room.rules : null;
  stage.update(room, rules, connection === "online");
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
  byId("loading").hidden = !!status;
  byId("lobby").hidden = !status || !!status.room;
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
    renderLobby();
  }
}

function applyStatus(next) {
  const previous = status;
  const roomChanged = previous?.room?.code !== next.room?.code || !!previous?.room !== !!next.room;
  const inviteCount = next.lobby.invites.length;
  if (roomChanged || next.room?.phase !== "playing" || previous?.room?.round !== next.room?.round) selection = null;
  if (roomChanged) savedLoadout = null;
  const active = document.activeElement;
  status = next;
  render();
  if (roomChanged) announce("");
  const phaseChanged = previous?.room?.phase !== next.room?.phase;
  if (roomChanged || active?.closest("[hidden]") || (phaseChanged && document.activeElement === document.body)) {
    const target = next.room ? byId("arena-title") : byId("lobby-title");
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
    setConnection("offline");
    render();
  } finally {
    setTimeout(poll, POLL_INTERVAL);
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
  announce("");
  render();
  try {
    const next = await requestAction({ action, ...fields });
    if (action === "move") selection = { move: fields.move };
    receiveStatus(next);
    if (action === "join") byId("join-code").value = "";
    if (action === "resume" && !next.room && !next.error) announce("没有可恢复的对战。");
    if (action === "loadout" && !next.error) announce("已保存配置。");
  } catch (error) {
    if (error instanceof ArenaRequestError) {
      if (!reloading) actionError = error.message;
    } else {
      checkResult = { action, ...fields };
      setConnection("offline");
    }
  } finally {
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
onAction("leave", "leave");

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

for (const button of moveButtons) {
  button.addEventListener("click", () => {
    if (status?.room?.phase !== "playing" || button.getAttribute("aria-disabled") === "true") return;
    runAction("move", { move: button.dataset.move, round: status.room.round });
  });
}

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
