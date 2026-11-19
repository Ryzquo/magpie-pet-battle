const SIDES = ["self", "opponent"];
const MOVES = {
  attack: "普攻", break: "破甲", shield: "护盾", counter: "反击",
  charge: "蓄力", heavy: "重击", heal: "回复",
};
const ATTACKS = new Set(["attack", "break", "heavy", "flare", "tide"]);
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
  const badge = layer(card, "p", "stage-badge");
  portrait.after(badge);
  badge.hidden = true;
  return { card, portrait, badge, sprite, key: null, health: card.querySelector(".health"),
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

function directDamage(action, opponent) {
  return Math.max(0, action.damage - opponent.counter);
}

function describe(round, action, opponent, rules, step) {
  const move = action.move;
  const name = action.name || rules?.skills?.[move]?.name || MOVES[move] || "超时";
  const pieces = [`第 ${round} 回合`, name];
  const damage = step >= 2 ? action.damage : directDamage(action, opponent);
  if (step >= 1 && damage > 0) pieces.push(`受伤 ${damage}`);
  if (step >= 2 && action.counter > 0) pieces.push(`反击 ${action.counter}`);
  if (step >= 3 && action.healing > 0) pieces.push(`回复 ${action.healing}`);
  if (step >= 3 && action.penalty > 0) pieces.push(`超时扣血 ${action.penalty}`);
  return pieces.join(" · ");
}

export function createStage(board, token) {
  const fighters = SIDES.map((side) => makeFighter(board, side));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const base = new URL(window.location.href);
  const frameCache = new Map();
  let previous = null;
  let current = null;
  let timers = [];
  let heldHp = null;
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
    for (const { portrait } of fighters) {
      delete portrait.dataset.move;
      delete portrait.dataset.effect;
      delete portrait.dataset.beat;
      delete portrait.dataset.hit;
      delete portrait.dataset.counter;
      delete portrait.dataset.strike;
    }
  }

  function showOutcome() {
    const room = current?.room;
    fighters.forEach(({ portrait }, index) => {
      delete portrait.dataset.outcome;
      if (room?.phase !== "finished" || room.winner == null) return;
      const canonicalIndex = index === 0 ? room.you : 1 - room.you;
      portrait.dataset.outcome = room.winner === "draw" ? "draw" : room.winner === canonicalIndex ? "win" : "loss";
    });
  }

  function showBadges(step) {
    const { round, actions, rules } = current;
    fighters.forEach(({ badge }, index) => {
      const action = actions?.[index];
      badge.hidden = !action;
      if (!action) {
        badge.textContent = "";
        delete badge.dataset.move;
        return;
      }
      const text = describe(round, action, actions[1 - index], rules, step);
      if (badge.textContent !== text) badge.textContent = text;
      badge.dataset.move = action.move || "timeout";
    });
  }

  function showHealth(values) {
    heldHp = values;
    fighters.forEach(({ health, healthLabel }, index) => {
      const max = current.players[index]?.maxHp;
      const hp = values[index];
      if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return;
      health.max = max;
      health.value = hp;
      healthLabel.textContent = `生命 ${hp} / ${max}`;
    });
  }

  function playRound() {
    const { actions } = current;
    heldHp = actions.map((action) => action.hpBefore);
    showBadges(0);
    const [left, right] = fighters.map(({ portrait }) => portrait.getBoundingClientRect());
    const distance = Math.abs((right.left + right.width / 2) - (left.left + left.width / 2));
    const simultaneous = actions.every(({ move }) => ATTACKS.has(move));
    const travel = Math.max(24, distance - (left.width + right.width) * .29);
    fighters.forEach(({ portrait }, index) => {
      delete portrait.dataset.outcome;
      portrait.dataset.move = actions[index].move || "timeout";
      if (actions[index].effect) portrait.dataset.effect = actions[index].effect;
      portrait.dataset.beat = "prep";
      portrait.toggleAttribute("data-strike", ATTACKS.has(actions[index].move));
      portrait.toggleAttribute("data-counter", actions[index].counter > 0);
      portrait.style.setProperty("--stage-range", `${distance}px`);
      portrait.style.setProperty("--stage-lunge", `${simultaneous ? travel / 2 : travel}px`);
    });

    const at = (delay, step, callback) => timers.push(setTimeout(() => {
      callback();
      showBadges(step);
    }, delay));
    const mark = (beat, hit) => fighters.forEach(({ portrait }, index) => {
      portrait.dataset.beat = beat;
      portrait.toggleAttribute("data-hit", hit(index));
    });
    const settleHealth = () => showHealth(current.players.map((player) => player?.hp));

    at(230, 1, () => {
      mark("impact", (index) => directDamage(actions[index], actions[1 - index]) > 0);
      showHealth(actions.map((action, index) => Math.max(0, action.hpBefore - directDamage(action, actions[1 - index]))));
    });
    if (actions.some(({ counter }) => counter > 0)) {
      at(395, 1, () => mark("counter", () => false));
      at(480, 2, () => {
        mark("return", (index) => actions[1 - index].counter > 0);
        showHealth(actions.map((action) => Math.max(0, action.hpBefore - action.damage)));
      });
    }
    at(610, 3, () => {
      mark("settle", (index) => actions[index].penalty > 0);
      settleHealth();
    });
    at(920, 3, () => {
      clearMotion();
      showOutcome();
    });
  }

  function update(room, rules, online = true) {
    if (!room || (room.you !== 0 && room.you !== 1)) {
      clearMotion();
      current = null;
      previous = null;
      showOutcome();
      for (const fighter of fighters) {
        showPet(fighter, null, framesFor);
        fighter.badge.hidden = true;
        fighter.badge.textContent = "";
        delete fighter.badge.dataset.move;
      }
      return;
    }

    const last = room.lastRound;
    const round = Number.isSafeInteger(last?.round) && last.actions?.length === 2 && last.actions.every(Boolean)
      ? last.round : 0;
    const order = [room.you, 1 - room.you];
    current = { room, rules, round, players: order.map((index) => room.players[index]),
      actions: round ? order.map((index) => last.actions[index]) : null };
    fighters.forEach((fighter, index) => showPet(fighter, current.players[index]?.pet, framesFor));

    const sameRoom = previous && previous.code === room.code && previous.you === room.you;
    const keepPlaying = sameRoom && previous.round === round && online && previous.online && !reducedMotion.matches;
    const consecutive = sameRoom && previous.online && online && previous.phase === "playing" &&
      round === previous.round + 1 && round === previous.roomRound;
    previous = { code: room.code, you: room.you, phase: room.phase, roomRound: room.round, round, online };
    if (keepPlaying && heldHp) return;

    clearMotion();
    if (consecutive && !reducedMotion.matches) {
      playRound();
    } else {
      showBadges(3);
      showOutcome();
    }
  }

  function visualHp(side, hp) {
    return heldHp?.[SIDES.indexOf(side)] ?? hp;
  }

  return { update, visualHp };
}
