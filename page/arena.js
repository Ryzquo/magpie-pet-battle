"use strict";

const byId = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="arena-token"]').content;
const moveButtons = [...document.querySelectorAll("[data-move]")];
const MAX_HP = 3;
const POLL_INTERVAL = 1000;
const REQUEST_TIMEOUT = 8000;

let status = null;
let pending = false;
let version = 0;
let actionError = "";
let pollError = "";
let connection = "connecting";
let selection = null;

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

function petDetails(pet) {
  return [pet?.species, pet?.stage != null ? `阶段 ${pet.stage}` : ""].filter(Boolean).join(" · ");
}

function disableAction(button, disabled) {
  if (disabled) button.setAttribute("aria-disabled", "true");
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
    const name = player.name || "附近玩家";
    const petName = typeof player.pet === "string" ? player.pet : player.pet?.name;
    const detail = petName && petName !== name ? petName : petDetails(player.pet);
    setText(row.querySelector("strong"), name);
    const description = row.querySelector(".player-info p");
    setText(description, detail);
    description.hidden = !detail;
    for (const button of row.querySelectorAll("button")) {
      button.setAttribute("aria-label", `${button.textContent}（${name}）`);
      disableAction(button, pending || (button.hasAttribute("data-pet-required") && !petAvailable));
    }
  }
  for (const row of previous.values()) row.remove();
}

function renderLobby() {
  const { pet, petError, lan, relayConfigured } = status;
  byId("pet-card").dataset.empty = String(!pet);
  setText(byId("pet-name"), pet?.name || "暂无宠物");
  message("pet-meta", petDetails(pet));
  message("pet-notice", !pet || petError
    ? [petError, !pet ? "请先在 Magpie 选择宠物，再发起或加入对战。" : ""].filter(Boolean).join(" ")
    : "");

  const discover = byId("discover");
  setText(discover, lan.discoverable ? "停止发现" : "开启发现");
  disableAction(discover, pending);
  message("lan-empty", lan.peers.length ? "" : lan.discoverable
    ? "正在扫描附近玩家。请好友在同一网络开启发现。"
    : "开启发现后，即可查找附近玩家。");
  byId("invites-section").hidden = !lan.invites.length;
  renderPlayers("peers", lan.peers, [["challenge", "挑战", "peerId", true]], !!pet);
  renderPlayers("invites", lan.invites, [
    ["accept", "接受", "inviteId", true],
    ["decline", "拒绝", "inviteId", false],
  ], !!pet);

  byId("relay-notice").hidden = relayConfigured;
  const codeAvailable = !!pet && relayConfigured;
  byId("join-code").disabled = !codeAvailable;
  byId("join-code").readOnly = pending;
  disableAction(byId("create"), !codeAvailable || pending);
  disableAction(byId("join"), !codeAvailable || pending);
  disableAction(byId("resume"), pending);
}

function renderFighter(id, fighter, phase) {
  const card = byId(id);
  card.dataset.empty = String(!fighter);
  setText(card.querySelector(".fighter-name"), fighter?.pet?.name || "等待加入");
  const meta = card.querySelector(".fighter-meta");
  const details = petDetails(fighter?.pet);
  setText(meta, details);
  meta.hidden = !details;

  const health = card.querySelector(".health");
  health.hidden = !fighter;
  const hp = fighter?.hp ?? 0;
  health.setAttribute("aria-label", `生命值 ${hp} / ${MAX_HP}`);
  [...health.children].forEach((segment, index) => segment.toggleAttribute("data-full", index < hp));

  let fighterState = "";
  if (fighter && phase === "waiting") fighterState = fighter.ready ? "已准备" : "未准备";
  if (fighter && phase === "playing") fighterState = fighter.locked ? "已锁定招式" : "正在选择";
  const state = card.querySelector(".fighter-state");
  setText(state, fighterState);
  state.hidden = !fighterState;
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

function renderArena() {
  const { room, mode } = status;
  const self = room.players[room.you];
  const opponent = room.players[1 - room.you];
  setText(byId("room-mode"), mode === "lan" ? "局域网对战" : "对战码房间");
  byId("room-code").hidden = mode !== "code" || room.phase !== "waiting" || !room.code;
  setText(byId("room-code-text"), room.code || "");
  setText(byId("leave"), room.phase === "playing" ? "退出对战" : "返回大厅");
  disableAction(byId("leave"), pending);
  renderFighter("fighter-self", self, room.phase);
  renderFighter("fighter-opponent", opponent, room.phase);
  const [title, detail] = battleCopy(room, self, opponent);
  setText(byId("battle-status"), title);
  message("battle-detail", detail);
  updateTimer();

  byId("ready-controls").hidden = room.phase !== "waiting";
  setText(byId("ready"), self?.ready ? "已准备" : "准备");
  disableAction(byId("ready"), pending || !self || self.ready);
  byId("round-controls").hidden = room.phase !== "playing";
  for (const button of moveButtons) {
    const selected = selection?.move === button.dataset.move;
    button.toggleAttribute("data-selected", selected);
    disableAction(button, pending || !self || self.locked);
  }
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
    renderLobby();
  }
}

function applyStatus(next) {
  const previous = status;
  const roomChanged = previous?.room?.code !== next.room?.code || !!previous?.room !== !!next.room;
  const inviteCount = next.lan.invites.length;
  if (roomChanged || next.room?.phase !== "playing" || previous?.room?.round !== next.room?.round) selection = null;
  status = next;
  render();
  if (roomChanged) announce("");
  if (roomChanged || (previous && previous.room?.phase !== next.room?.phase)) {
    const target = next.room ? byId("arena-title") : byId("lobby-title");
    const active = document.activeElement;
    if (active === document.body || active.closest("[hidden]") || roomChanged) target.focus();
  }
  if (!next.room && inviteCount > (previous?.lan.invites.length || 0)) announce(`收到 ${inviteCount} 个挑战邀请。`);
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
      if (now - Number(url.searchParams.get("reconnect")) >= REQUEST_TIMEOUT) {
        url.searchParams.set("reconnect", String(now));
        location.replace(url.href);
      }
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.lan) throw new ArenaRequestError(body?.error || "对战服务暂时不可用。");
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function poll() {
  const requestVersion = version;
  const startedDuringAction = pending;
  try {
    const next = await request("/api/status");
    if (requestVersion !== version || startedDuringAction) return;
    pollError = "";
    setConnection("online");
    applyStatus(next);
  } catch (error) {
    if (requestVersion !== version || startedDuringAction) return;
    pollError = error instanceof ArenaRequestError ? error.message : "";
    setConnection("offline");
    render();
  } finally {
    setTimeout(poll, POLL_INTERVAL);
  }
}

async function runAction(action, fields) {
  if (pending || !status) return;
  pending = true;
  version += 1;
  actionError = "";
  announce("");
  render();
  try {
    const next = await request("/api/action", { action, ...fields });
    pollError = "";
    setConnection("online");
    if (action === "move") selection = { move: fields.move };
    applyStatus(next);
    if (action === "join") byId("join-code").value = "";
    if (action === "challenge" && !next.room && !next.error) announce("已发送挑战，等待好友接受。");
    if (action === "resume" && !next.room && !next.error) announce("没有可恢复的对战。");
  } catch (error) {
    actionError = error instanceof ArenaRequestError ? error.message : "未收到操作结果。请查看当前状态后再试。";
    if (!(error instanceof ArenaRequestError)) setConnection("offline");
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

onAction("discover", "discover", () => ({ enabled: !status.lan.discoverable }));
onAction("create", "create");
onAction("resume", "resume");
onAction("ready", "ready");
onAction("leave", "leave");

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
