const SIDES = ["self", "opponent"];
const ATTACKS = new Set(["attack", "break", "heavy", "tide"]);
const PALETTES = [164, 204, 267, 324, 22, 47];

function layer(parent, tag, className) {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;
  parent.append(node);
  return node;
}

function makeFighter(board, side) {
  const card = board.querySelector(`#fighter-${side}`);
  const portrait = card.querySelector(":scope > .portrait");
  portrait.classList.add("stage-portrait");
  portrait.setAttribute("aria-hidden", "true");
  portrait.replaceChildren();
  const body = layer(portrait, "span", "stage-pet");
  const art = layer(body, "span", "stage-art");
  layer(art, "span", "stage-face");
  const sprite = layer(body, "span", "stage-sprite");
  layer(portrait, "span", "stage-effect");
  const amount = layer(portrait, "span", "stage-amount");
  const badge = layer(card, "p", "stage-badge");
  portrait.after(badge);
  badge.hidden = true;
  return { portrait, badge, sprite, amount, key: null, health: card.querySelector(".health"),
    healthLabel: card.querySelector(".health-label") };
}

function sameOriginFrame(value, base) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, base);
    return url.origin === base.origin && url.pathname.endsWith(".png") ? url.href : null;
  } catch {
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.alt = "";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function showPet(fighter, pet, framesFor) {
  const species = pet?.speciesId || "";
  const key = pet ? species || pet.name || "pet" : null;
  if (key === fighter.key) return;
  fighter.key = key;
  const { portrait, sprite } = fighter;
  delete portrait.dataset.sprite;
  sprite.replaceChildren();
  if (!key) return;

  const hash = [...key].reduce((value, char) => Math.imul(value, 31) + char.codePointAt(0) >>> 0, 0);
  portrait.dataset.shape = hash % 4;
  portrait.dataset.expression = Math.floor(hash / 4) % 3;
  portrait.style.setProperty("--pet-hue", PALETTES[Math.floor(hash / 12) % PALETTES.length]);
  if (!species) return;

  framesFor(species).then((frames) => {
    const first = frames.find(Boolean);
    if (fighter.key !== key || !first) return;
    sprite.replaceChildren();
    const idle = [frames[0], frames[1]].filter(Boolean);
    if (!idle.length) idle.push(first);
    const attack = [frames[6], frames[7]].filter(Boolean);
    for (const [pose, images] of [["idle", idle], ["attack", attack], ["win", [frames[2]].filter(Boolean)]]) {
      if (!images.length) continue;
      const strip = layer(sprite, "span", "stage-frames");
      strip.dataset.pose = pose;
      strip.toggleAttribute("data-pair", images.length === 2);
      strip.append(...images.map((image) => image.cloneNode()));
    }
    portrait.dataset.sprite = "";
  });
}

export function createStage(board, token, onComplete) {
  const fighters = SIDES.map((side) => makeFighter(board, side));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const base = new URL(window.location.href);
  const frameCache = new Map();
  let previous = null;
  let timers = [];
  let heldHp = null; // Canonical seat order throughout the timeline.
  board.classList.add("battle-stage");

  function framesFor(species) {
    if (!frameCache.has(species)) {
      const frames = (async () => {
        const headers = token ? { "X-Arena-Token": token } : {};
        const response = await fetch(new URL(`/api/sprite/${encodeURIComponent(species)}`, base), { headers });
        if (!response.ok) return [];
        const data = await response.json();
        if (!Array.isArray(data?.frames)) return [];
        const urls = data.frames.slice(0, 8).map((url) => sameOriginFrame(url, base));
        return Promise.all(urls.map((url) => url ? loadImage(url) : null));
      })().catch(() => []);
      frameCache.set(species, frames);
    }
    return frameCache.get(species);
  }

  function clearMotion() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    heldHp = null;
    delete board.dataset.shake;
    for (const { portrait, amount } of fighters) {
      for (const key of ["move", "effect", "beat", "hit", "impact", "counter", "strike"]) delete portrait.dataset[key];
      amount.textContent = "";
      delete amount.dataset.kind;
    }
  }

  function showHealth(room, values) {
    heldHp = values;
    fighters.forEach(({ portrait, health, healthLabel }, index) => {
      const seat = index === 0 ? room.you : 1 - room.you;
      portrait.toggleAttribute("data-down", values[seat] === 0);
      health.max = room.players[seat].maxHp;
      health.value = values[seat];
      healthLabel.textContent = `生命 ${values[seat]} / ${health.max}`;
    });
  }

  function showBadges(room, rules, resolved) {
    const action = room?.lastAction;
    fighters.forEach(({ badge }, index) => {
      const seat = index === 0 ? room?.you : 1 - room?.you;
      const parts = [];
      if (action && seat === action.actor) {
        const move = action.name || rules?.skills?.[action.move]?.name || ({ decline: "放弃复活", timeout: "超时" })[action.move] || "超时";
        parts.push(`第 ${action.turn} 手`, move);
        if (resolved && action.healing) parts.push(`恢复 ${action.healing}`);
        if (resolved && action.penalty) parts.push(`超时扣血 ${action.penalty}`);
        if (resolved && action.counter) parts.push(`受反击 ${action.counter}`);
      } else if (action && resolved) {
        if (action.damage) parts.push(`受伤 ${action.damage}`);
        if (action.counter) parts.push(`反击 ${action.counter}`);
      }
      badge.hidden = !parts.length;
      const text = parts.join(" · ");
      if (text !== badge.textContent) badge.textContent = text;
      badge.dataset.move = action?.move || "";
    });
  }

  function play(room, rules) {
    const action = room.lastAction;
    const { actor, hpBefore, hpAfter, damage, counter, penalty, healing } = action;
    const target = 1 - actor;
    const source = fighters[actor === room.you ? 0 : 1];
    const receiver = fighters[target === room.you ? 0 : 1];
    const [left, right] = fighters.map(({ portrait }) => portrait.getBoundingClientRect());
    const distance = Math.abs((right.left + right.width / 2) - (left.left + left.width / 2));
    for (const { portrait } of fighters) {
      delete portrait.dataset.outcome;
      portrait.style.setProperty("--stage-range", `${distance}px`);
      portrait.style.setProperty("--stage-lunge", `${Math.max(0, distance - (left.width + right.width) * .29)}px`);
    }
    source.portrait.dataset.move = action.move || "timeout";
    source.portrait.dataset.beat = "prep";
    if (action.effect) source.portrait.dataset.effect = action.effect;
    source.portrait.toggleAttribute("data-strike", ATTACKS.has(action.move));
    showHealth(room, [...hpBefore]);
    showBadges(room, rules, false);
    const at = (delay, callback) => timers.push(setTimeout(callback, delay));
    const float = (fighter, value, kind) => {
      fighter.amount.dataset.kind = kind;
      fighter.amount.textContent = `${kind === "heal" ? "+" : "−"}${value}`;
      if (kind === "heal") return;
      fighter.portrait.dataset.hit = "";
      fighter.portrait.dataset.impact = kind === "counter" ? "counter" : action.move;
      board.dataset.shake = kind === "counter" ? "counter" : action.move === "heavy" ? "heavy" : "light";
    };
    const impact = action.move === "flare" ? 290 : 230;
    at(impact, () => {
      source.portrait.dataset.beat = "impact";
      if (damage) float(receiver, damage, "hit");
      if (penalty) float(source, penalty, "hit");
      if (healing) float(source, healing, "heal");
      const values = [...hpAfter];
      if (counter) values[actor] = Math.min(room.players[actor].maxHp, hpBefore[actor] + healing);
      showHealth(room, values);
    });
    if (counter) {
      at(impact + 150, () => {
        delete receiver.portrait.dataset.hit;
        delete board.dataset.shake;
        receiver.portrait.dataset.counter = "";
        receiver.portrait.dataset.beat = "counter";
      });
      at(impact + 240, () => {
        source.portrait.dataset.beat = "return";
        float(source, counter, "counter");
        showHealth(room, hpAfter);
      });
    }
    at(impact + (counter ? 555 : 305), () => {
      clearMotion();
      onComplete();
    });
  }

  function update(room, rules, online = true) {
    const action = room?.lastAction;
    const visible = online && !document.hidden && !reducedMotion.matches;
    const sameRoom = !!room && previous?.code === room.code && previous?.you === room.you;
    const sameAction = sameRoom && previous.actionTurn === action?.turn;
    const consecutive = sameRoom && previous.visible && visible && previous.phase === "playing" &&
      action?.turn === previous.turn && action.turn === (previous.actionTurn ?? 0) + 1;
    const keepPlaying = sameAction && previous.phase === room?.phase && heldHp && visible;
    previous = room ? { code: room.code, you: room.you, turn: room.turn, phase: room.phase, actionTurn: action?.turn, visible } : null;
    if (keepPlaying) return;
    clearMotion();
    fighters.forEach((fighter, index) => {
      const seat = index === 0 ? room?.you : 1 - room?.you;
      showPet(fighter, room?.players[seat]?.pet, framesFor);
      fighter.portrait.toggleAttribute("data-down", room?.players[seat]?.hp === 0);
      delete fighter.portrait.dataset.outcome;
      if (room?.phase === "finished" && room.winner != null) {
        fighter.portrait.dataset.outcome = room.winner === "draw" ? "draw" : room.winner === seat ? "win" : "loss";
      }
    });
    if (consecutive && !sameAction && [0, 1].includes(action.actor) && action.hpBefore?.length === 2 && action.hpAfter?.length === 2) play(room, rules);
    else showBadges(room, rules, true);
  }

  function invalidate() {
    previous = null;
    clearMotion();
    onComplete();
  }
  reducedMotion.addEventListener("change", invalidate);
  return { update, invalidate, get busy() { return !!heldHp; }, visualHp: (seat, hp) => heldHp?.[seat] ?? hp };
}
