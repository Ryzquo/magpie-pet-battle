import { createScenery } from "./adventure-scenery.js";
import { createStage } from "./stage.js";
import { moveCard, paintMoveCard, rewardCard } from "./cards.js";

const byId = (id) => document.getElementById(id);
const equippedCount = 2;
// Presentation only; encounter IDs and combat stats remain part of the saved run.
const enemySpecies = { scout: "4-047", guard: "4-054", hunter: "3-023", "iron-king": "4-054", "ember-dragon": "4-055" };
const equipmentKinds = ["title", "effect"];
const skillNames = {
  attack: "普攻", break: "破甲", shield: "护盾", counter: "反击", charge: "蓄力",
  heavy: "重击", heal: "回复", revive: "复活",
};
const phaseTitles = {
  root: "选择起始形态", battle: "选择招式", reward: "选择战后强化",
  route: "选择下一站", evolve: "进化或专精", ended: "冒险结束",
};

function addText(node, tag, text, className = "") {
  const child = document.createElement(tag);
  child.className = className;
  child.textContent = text;
  node.append(child);
  return child;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function createAdventure({ token, runAction, rerender, petDetails, skillDetails, fighterEffects, renderLoadout, setAttributeBadge, framesFor }) {
  const openButton = byId("adventure-open");
  const back = byId("adventure-back");
  const title = byId("adventure-title");
  const phaseTitle = byId("adventure-phase-title");
  const start = byId("adventure-start");
  const prep = byId("adventure-prep");
  const pointInputs = [...byId("adventure-point-fields").querySelectorAll("input")];
  const readPoints = () => Object.fromEntries(pointInputs.map((input) => [input.name, input.valueAsNumber]));
  const board = byId("adventure-board");
  const renderScenery = createScenery(byId("adventure-scenery"), byId("adventure-scene-label"));
  const stage = createStage(board, token, rerender);
  const choices = byId("adventure-choices");
  const end = byId("adventure-end");
  const endConfirm = byId("adventure-end-confirm");
  const endCancel = byId("adventure-end-cancel");
  const endSubmit = byId("adventure-end-submit");
  const log = byId("adventure-log");
  const selects = equipmentKinds.map((kind) => byId(`adventure-${kind}-select`));
  const skillInputs = Object.entries(skillNames).filter(([id]) => id !== "attack").map(([id, name]) => {
    const label = document.createElement("label");
    label.className = "skill-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = id;
    input.checked = ["break", "shield"].includes(id);
    label.append(input);
    const copy = addText(label, "span", "");
    addText(copy, "strong", name);
    const description = addText(copy, "span", "", "skill-description");
    byId("adventure-skill-fields").append(label);
    const cost = addText(copy, "small", "");
    return { input, description, cost };
  });

  let snapshot;
  let opened = false;
  let newRun = false;
  let confirmingEnd = false;
  let blocked = true;
  let phase = null;
  let choiceKey = "";
  let logKey = "";
  let unlockKey = "";
  let queuedActions = [];
  let playingRevision = null;
  let thresholdPending = false;
  let selectedMove = null;
  const active = () => opened && !!snapshot?.adventure && !snapshot.room;

  function enter(prepare = false) {
    opened = true;
    newRun = prepare;
    confirmingEnd = false;
    rerender();
    title.focus();
  }

  function leave() {
    opened = false;
    newRun = false;
    confirmingEnd = false;
    rerender();
    openButton.focus();
  }

  async function submit(action, fields = {}) {
    if (blocked || stage.busy || !snapshot.adventure) return;
    if (action === "adventure-move") selectedMove = fields.value;
    try {
      await runAction(action, { ...fields, adventureRevision: snapshot.adventure.revision });
    } finally {
      if (selectedMove) {
        selectedMove = null;
        rerender();
      }
    }
  }

  openButton.addEventListener("click", () => {
    if (openButton.getAttribute("aria-disabled") !== "true") enter();
  });
  back.addEventListener("click", () => {
    if (back.getAttribute("aria-disabled") !== "true") leave();
  });
  prep.addEventListener("input", rerender);
  prep.addEventListener("submit", (event) => {
    event.preventDefault();
    if (start.getAttribute("aria-disabled") === "true") return;
    submit("adventure-start", { points: readPoints(), skills: skillInputs.filter(({ input }) => input.checked).map(({ input }) => input.value) });
  });
  byId("adventure-controls").addEventListener("keydown", (event) => {
    if (phase !== "battle" || !/^[1-4]$/.test(event.key) || event.repeat || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const button = choices.children[Number(event.key) - 1];
    if (!button) return;
    event.preventDefault();
    button.click();
  });
  end.addEventListener("click", () => {
    if (end.getAttribute("aria-disabled") === "true") return;
    confirmingEnd = true;
    rerender();
    endCancel.focus();
  });
  endCancel.addEventListener("click", () => {
    if (endCancel.getAttribute("aria-disabled") === "true") return;
    confirmingEnd = false;
    rerender();
    end.focus();
  });
  endSubmit.addEventListener("click", () => {
    if (endSubmit.getAttribute("aria-disabled") !== "true") submit("adventure-end");
  });
  selects.forEach((select, index) => select.addEventListener("change", () => {
    submit("adventure-equip", { kind: equipmentKinds[index], value: select.value });
  }));

  function renderLobby(adventure) {
    const { run, best, unlocks, equipped } = adventure;
    const ongoing = run && run.phase !== "ended";
    setText(byId("adventure-lobby-detail"), ongoing ? `已保存第 ${run.floor} 关，可随时继续。`
      : run ? `上次冒险通过 ${run.cleared} 关。` : "单人闯关，每 5 关遇到首领。");
    setText(byId("adventure-best"), `最高通关 ${best} 关`);
    setText(openButton, ongoing ? "继续冒险" : run ? "查看上次冒险" : "准备冒险");
    openButton.setAttribute("aria-disabled", String(blocked || (!run && !snapshot.pet)));
    const warning = byId("adventure-lobby-blocked");
    const reason = snapshot.lobby.challengePending ? "挑战已发出。取消挑战后可打开冒险或调整装扮。"
      : !run && !snapshot.pet ? "请先在 Magpie 选择宠物。" : "";
    setText(warning, reason);
    warning.hidden = !reason;
    setText(byId("adventure-cosmetics-detail"), unlocks.length ? "装备后会在联机对战中展示。"
      : "击败第 5 关首领后，解锁首批称号和入场特效。");
    byId("adventure-equipment").hidden = !unlocks.length;
    const key = JSON.stringify(unlocks);
    selects.forEach((select, index) => {
      const kind = equipmentKinds[index];
      const items = unlocks.filter((item) => item.kind === kind);
      if (key !== unlockKey) {
        select.replaceChildren(new Option("不装备", ""), ...items.map(({ name, id }) => new Option(name, id)));
      }
      select.value = equipped[kind] || "";
      select.disabled = blocked || !items.length;
    });
    unlockKey = key;
  }

  function renderPrep(rules) {
    setText(byId("adventure-evolution-detail"), snapshot.adventure.hasEvolutionData === false
      ? "缺少进化图鉴，将从当前形态出发并可选专精。" : "伙伴会从进化路线的起点出发。");
    const budget = rules?.pointBudget;
    const points = pointInputs.map((input) => input.valueAsNumber);
    const spent = points.reduce((sum, value) => sum + value, 0);
    const validPoints = points.every((value) => Number.isInteger(value) && value >= 0) && spent === budget;
    for (const input of pointInputs) input.disabled = blocked;
    setText(byId("adventure-point-summary"), `${Number.isFinite(spent) ? spent : "—"} / ${budget ?? "—"} 点已分配`);
    for (const { input, description, cost } of skillInputs) {
      input.disabled = blocked;
      const skill = rules?.skills?.[input.value];
      const detail = input.value === "revive" ? "倒下时可以复活，每场限一次。" : skill?.description || "";
      setText(description, detail);
      description.hidden = !detail;
      setText(cost, skill ? skillDetails(skill) : "");
    }
    const count = skillInputs.filter(({ input }) => input.checked).length;
    setText(byId("adventure-skill-count"), `${count} / ${equippedCount} 项已选${count > equippedCount ? "，请取消多选的技能。" : ""}`);
    start.setAttribute("aria-disabled", String(blocked || !snapshot.pet || !validPoints || count !== equippedCount));
  }

  function renderFighter(side, fighter, pet, rules) {
    const meta = byId(`adventure-${side}-meta`);
    setText(byId(`adventure-${side}-name`), pet?.name || fighter.name || "宠物");
    const detail = [petDetails(pet, true), fighter.boss ? "首领" : fighter.elite ? "精英" : ""].filter(Boolean).join(" · ");
    setText(meta, detail);
    meta.hidden = !detail;
    if (side === "self") setAttributeBadge(board.querySelector(".fighter-attribute"), pet?.attribute);
    const health = byId(`adventure-${side}-health`);
    const hp = stage.visualHp(side === "self" ? 0 : 1, fighter.hp);
    health.max = fighter.maxHp;
    health.value = hp;
    setText(byId(`adventure-${side}-hp`), `生命 ${hp} / ${fighter.maxHp}`);
    const energy = byId(`adventure-${side}-energy`);
    energy.hidden = stage.busy;
    setText(energy, `体力 ${fighter.energy} / ${rules.maxEnergy}`);
    const effects = byId(`adventure-${side}-effects`);
    const activeEffects = fighterEffects(fighter, rules);
    effects.hidden = stage.busy || !activeEffects;
    setText(effects, activeEffects);
  }

  function moveChoices(player, rules) {
    const reviving = player.hp === 0 && player.skills.includes("revive") && !player.reviveUsed;
    const ids = reviving ? ["revive", "decline"] : ["attack", ...player.skills, player.innateSkill.id];
    return ids.map((id, index) => {
      const shortcut = String(index + 1);
      if (id === "decline") return { id, name: "放弃复活", description: "结束本次冒险。", shortcut };
      const innate = id === player.innateSkill.id;
      const skill = innate ? player.innateSkill : rules.skills[id];
      const cooldown = player.cooldowns[id] || 0;
      const restriction = id === "revive" && !reviving ? (player.reviveUsed ? "本场已使用" : "倒下时可用") : "";
      const reason = [restriction, cooldown ? `冷却 ${cooldown} 手` : "", skill.cost > player.energy ? "体力不足" : ""]
        .filter(Boolean).join(" · ");
      return { id, name: skill.name, shortcut,
        description: id === "revive" ? "恢复 30% 最大生命值（向上取整），每场限一次。" : skill.description,
        detail: skillDetails(skill), innate: innate ? skill.effect || id : "", powered: innate && player.energy >= skill.cost, reason };
    });
  }

  function renderChoices(run, rules) {
    const isBattle = run.phase === "battle";
    const finished = run.phase === "ended";
    const options = isBattle ? moveChoices(run.player, rules) : finished
      ? [{ id: "new", name: "准备新冒险", reason: snapshot.pet ? "" : "请先在 Magpie 选择宠物" }]
      : run.options;
    const key = JSON.stringify([run.phase, run.pet?.speciesId, options]);
    if (key !== choiceKey) {
      const focused = document.activeElement;
      const value = choices.contains(focused) ? focused.dataset.value : null;
      const buttons = options.map((option) => {
        const { id, name, description } = option;
        let button;
        if (isBattle) {
          button = moveCard();
          paintMoveCard(button, { ...option, speciesId: run.pet?.speciesId }, framesFor);
          button.addEventListener("animationend", (event) => {
            if (event.animationName === "innate-threshold") button.removeAttribute("data-threshold");
          });
        } else if (run.phase === "reward") {
          button = rewardCard(option);
        } else {
          button = document.createElement("button");
          button.type = "button";
          button.className = "move";
          addText(button, "strong", name);
          if (description) addText(button, "span", description, "skill-description");
          addText(button, "small", "", "move-state");
        }
        button.dataset.value = id;
        button.addEventListener("click", () => {
          if (button.getAttribute("aria-disabled") === "true") return;
          if (finished) enter(true);
          else submit(isBattle ? "adventure-move" : "adventure-choose", { value: id });
        });
        return button;
      });
      choices.replaceChildren(...buttons);
      if (value != null) (buttons.find((button) => button.dataset.value === value && run.phase === phase) || phaseTitle).focus();
      choiceKey = key;
    }
    [...choices.children].forEach((button, index) => {
      const { id, reason, innate } = options[index];
      const selected = !stage.busy && selectedMove === id;
      button.toggleAttribute("data-selected", selected);
      const feedback = stage.busy ? "结算中" : selected ? "正在提交…" : "";
      const availability = reason || (isBattle ? (innate ? "已就绪" : "可用") : "");
      setText(button.lastElementChild, [feedback, availability].filter(Boolean).join(" · "));
      button.lastElementChild.hidden = !button.lastElementChild.textContent;
      button.setAttribute("aria-disabled", String(blocked || stage.busy || confirmingEnd || !!reason));
      if (innate && !stage.busy && thresholdPending) {
        thresholdPending = false;
        button.setAttribute("data-threshold", "");
      }
    });
  }

  function presentMove(next, move) {
    const previous = snapshot?.adventure;
    const current = next.adventure;
    const actions = current?.run?.lastActions;
    if (!active() || document.hidden || move === "decline" || !previous ||
        current?.revision !== previous.revision + 1 || actions?.[0]?.move !== move) return;
    queuedActions = actions;
    const before = previous.run.player;
    const after = current.run.player;
    const readyCost = after.innateSkill.cost;
    thresholdPending = current.run.phase === "battle" && after.hp > 0 && before.energy < readyCost && after.energy >= readyCost;
  }

  function invalidate() {
    queuedActions = [];
    thresholdPending = false;
    choices.querySelector("[data-threshold]")?.removeAttribute("data-threshold");
    stage.invalidate();
  }

  function render(next, { pending, offline }) {
    snapshot = next;
    blocked = pending || offline || !!next?.lobby.challengePending || !Number.isSafeInteger(next?.adventure?.revision);
    if (next?.room) {
      opened = false;
      newRun = false;
      confirmingEnd = false;
    }
    const visible = active();
    byId("adventure").hidden = !visible;
    byId("adventure-lobby").hidden = !next?.adventure;
    if (!visible) {
      if (next?.adventure && !next.room) renderLobby(next.adventure);
      queuedActions = [];
      thresholdPending = false;
      stage.update(null);
      phase = null;
      return false;
    }

    const { adventure } = next;
    if (adventure.run && adventure.run.phase !== "ended") newRun = false;
    const run = newRun ? null : adventure.run;
    const rules = adventure.rules;
    const isBattle = run?.phase === "battle";
    const reviving = isBattle && run.player.hp === 0;
    const ongoing = run && run.phase !== "ended";
    if (!ongoing) confirmingEnd = false;
    const won = run?.enemy?.hp === 0 && (run.phase === "reward" || run.phase === "evolve");
    const lost = run?.phase === "ended" && run.player.hp === 0;
    const showBoard = !!run?.enemy && (isBattle || won || lost);
    const activeElement = document.activeElement;
    setText(back, ongoing ? "保存并返回大厅" : "返回大厅");
    back.setAttribute("aria-disabled", String(pending));
    setText(byId("adventure-progress"), ongoing ? `第 ${run.floor} 关 · 已通过 ${run.cleared} 关` : `最高通关 ${adventure.best} 关`);
    prep.hidden = !!run;
    if (!run) renderPrep(rules);
    board.hidden = !showBoard;
    if (stage.busy && (offline || playingRevision !== adventure.revision)) {
      thresholdPending = false;
      stage.update(null);
    }
    if (showBoard) {
      renderScenery(run);
      const enemy = { ...run.enemy, pet: { name: run.enemy.name, speciesId: enemySpecies[run.enemy.id] } };
      const lastAction = run.lastActions?.at(-1);
      const scene = { code: `${run.floor}:${enemy.id}:${!!enemy.elite}`, you: 0, turn: (lastAction?.turn || 0) + 1,
        phase: won || lost ? "finished" : "playing", winner: won ? 0 : lost ? 1 : null,
        players: [{ ...run.player, pet: run.pet }, enemy], lastAction };
      if (queuedActions.length && !offline) {
        playingRevision = adventure.revision;
        stage.playSequence(scene, rules, queuedActions);
      }
      if (!stage.busy) stage.update(scene, rules, false);
      renderFighter("self", run.player, run.pet, rules);
      renderFighter("enemy", run.enemy, null, rules);
      setText(byId("adventure-intent"), stage.busy ? "行动结算" : reviving ? "伙伴倒下" : won ? "战斗胜利" : lost ? "战斗失败" : "敌方意图");
      setText(byId("adventure-intent-detail"), stage.busy || won || lost ? "" : run.intent);
    } else stage.update(null);
    queuedActions = [];
    const loadouts = byId("adventure-loadouts");
    loadouts.hidden = !isBattle || stage.busy;
    if (!loadouts.hidden) {
      renderLoadout("adventure-loadout-self", run.player, rules, "playing");
      renderLoadout("adventure-loadout-enemy", { ...run.enemy, innateSkill: null }, rules, "playing");
    }
    byId("adventure-controls").hidden = !run;
    if (stage.busy) {
      for (const button of choices.children) {
        button.setAttribute("aria-disabled", "true");
        button.removeAttribute("data-selected");
        button.lastElementChild.hidden = false;
        setText(button.lastElementChild, "结算中");
      }
    } else if (run) {
      setText(phaseTitle, reviving ? "复活选择" : phaseTitles[run.phase] || "当前选择");
      const detail = run.phase === "ended" ? `本次通过 ${run.cleared} 关。` : isBattle ?
        `在招式区内可按数字键 ${reviving ? "1–2" : "1–4"} 选择。` : run.phase === "root" ? "" :
        `${run.pet.species || run.pet.name} · 生命 ${run.player.hp} / ${run.player.maxHp}`;
      setText(byId("adventure-phase-detail"), detail);
      renderChoices(run, rules);
    }
    const lines = run?.log || [];
    byId("adventure-history").hidden = !lines.length;
    const nextLogKey = JSON.stringify(lines);
    if (logKey !== nextLogKey) {
      log.replaceChildren();
      for (const line of [...lines].reverse()) addText(log, "li", line);
      logKey = nextLogKey;
    }
    byId("adventure-actions").hidden = !ongoing;
    end.hidden = confirmingEnd;
    endConfirm.hidden = !confirmingEnd;
    end.setAttribute("aria-disabled", String(blocked || stage.busy));
    endSubmit.setAttribute("aria-disabled", String(blocked || stage.busy));
    endCancel.setAttribute("aria-disabled", String(pending));
    if (!stage.busy) {
      if (phase && phase !== run?.phase && activeElement.closest("#adventure")) (run ? phaseTitle : title).focus();
      phase = run?.phase || null;
    }
    return true;
  }

  return { render, presentMove, invalidate };
}
