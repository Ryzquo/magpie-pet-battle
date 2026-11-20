const moveMarks = {
  attack: "✦", break: "◈", shield: "⬡", counter: "↶", charge: "↑", heavy: "✹", heal: "+", revive: "✚", decline: "×",
  flare: "✸", "blue-flame": "✷", "magic-flame": "✧", gust: "≋", spark: "ϟ", tide: "≈", aegis: "✥", ivy: "❧",
};

const rewardThemes = {
  fang: ["attack", "✦"], opening: ["attack", "↑"], pierce: ["attack", "◈"], resolve: ["attack", "✹"],
  carapace: ["guard", "⬡"], bastion: ["guard", "✥"],
  heart: ["recovery", "♥"], vampire: ["recovery", "◒"], harvest: ["recovery", "✧"], tonic: ["recovery", "✚"],
  battery: ["energy", "ϟ"], focus: ["innate", "✸"],
};
const categoryNames = { attack: "进攻", guard: "防御", recovery: "续航", energy: "体力", innate: "固有技能" };

function append(parent, tag, className, text = "") {
  const child = document.createElement(tag);
  child.className = className;
  child.textContent = text;
  parent.append(child);
  return child;
}

function text(node, value = "") {
  if (node.textContent !== value) node.textContent = value;
  node.hidden = !value;
}

function mark(parent) {
  const icon = append(parent, "span", "card-mark");
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

export function moveCard() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "move move-card";
  mark(button);
  const sprite = append(button, "img", "card-sprite");
  sprite.alt = "";
  sprite.hidden = true;
  const heading = append(button, "span", "card-heading");
  const key = append(heading, "kbd", "card-key");
  key.setAttribute("aria-hidden", "true");
  append(heading, "span", "card-kind");
  append(heading, "strong", "card-name");
  append(button, "span", "skill-description");
  append(button, "small", "card-detail");
  append(button, "small", "move-state");
  return button;
}

export function paintMoveCard(button, { id, name, description, detail, shortcut, innate, powered, speciesId }, framesFor) {
  button.dataset.move = id;
  button.setAttribute("aria-keyshortcuts", shortcut);
  if (innate) button.dataset.innate = innate;
  else delete button.dataset.innate;
  button.toggleAttribute("data-powered", !!powered);
  text(button.querySelector(".card-mark"), moveMarks[innate || id] || "✦");
  text(button.querySelector(".card-key"), shortcut);
  text(button.querySelector(".card-kind"), innate ? "固有技能" : "");
  text(button.querySelector(".card-name"), name);
  text(button.querySelector(".skill-description"), description);
  text(button.querySelector(".card-detail"), detail);

  const sprite = button.querySelector(".card-sprite");
  const species = innate && speciesId ? speciesId : "";
  if (sprite.dataset.species === species) return;
  sprite.dataset.species = species;
  sprite.hidden = true;
  sprite.removeAttribute("src");
  if (!species) return;
  framesFor(species).then((frames) => {
    const image = frames[6] || frames.find(Boolean);
    if (sprite.dataset.species !== species || !image) return;
    sprite.src = image;
    sprite.hidden = false;
  });
}

export function rewardCard({ id, name, description, reward }) {
  const button = document.createElement("button");
  button.className = "move reward-card";
  button.type = "button";
  const [theme, symbol] = rewardThemes[id] || ["innate", "✦"];
  button.dataset.rewardTheme = reward?.capped ? "recovery" : theme;
  const art = append(button, "span", "reward-art");
  mark(art).textContent = reward?.capped ? "✚" : symbol;
  append(art, "span", "reward-category", reward?.capped ? "生命补给" : categoryNames[theme]);
  append(button, "strong", "card-name", name);
  append(button, "span", "reward-payoff", reward?.effect || description);
  if (reward?.note) append(button, "small", "reward-note", reward.note);
  if (reward) {
    const { level, maxRank, capped } = reward;
    const rank = append(button, "small", "reward-rank");
    const pips = append(rank, "span", "reward-pips");
    pips.setAttribute("aria-hidden", "true");
    for (let i = 0; i < maxRank; i++) {
      const pip = append(pips, "span", "reward-pip");
      if (i < level) pip.dataset.earned = "";
      else if (i === level && !capped) pip.dataset.next = "";
    }
    append(rank, "span", "", capped ? `已满阶 ${maxRank}/${maxRank}` : `${level} → ${level + 1} / ${maxRank} 阶`);
  }
  append(button, "small", "move-state");
  return button;
}
