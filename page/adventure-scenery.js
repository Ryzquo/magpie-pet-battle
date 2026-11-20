// Palette order: sky, horizon, distant terrain, near terrain, ground, shade, highlight.
const biomes = {
  forest: { name: "林径", colors: ["#243f47", "#9eb393", "#749788", "#496d59", "#788867", "#536a50", "#a1ac79"],
    props: ["tree", "column", "log", "wall", "fern", "roots"] },
  coast: { name: "潮汐海岸", colors: ["#255b76", "#a4d3ce", "#598ea0", "#347c8d", "#a69870", "#7e765a", "#d2ba89"],
    props: ["wreck", "pier", "reef", "pool", "log", "column"] },
  marsh: { name: "雾泽", colors: ["#333b3e", "#a5ab8f", "#7b8e75", "#526b60", "#687660", "#48584e", "#9b9b6b"],
    props: ["roots", "reeds", "pool", "pier", "fern", "wall"] },
  desert: { name: "风蚀荒漠", colors: ["#765156", "#f2c689", "#c79375", "#9f6d56", "#bc8b62", "#8c614c", "#deb47e"],
    props: ["column", "wall", "bones", "cactus", "reef", "arch"] },
  snow: { name: "霜雪原", colors: ["#354e74", "#c3dce4", "#8ea8bd", "#66869e", "#a9c0c7", "#748fa0", "#dce8e6"],
    props: ["pine", "ice", "wall", "arch", "log", "bones"] },
  cavern: { name: "晶岩洞窟", colors: ["#231d36", "#5b516c", "#51435f", "#40374e", "#6f6576", "#484254", "#9f8ca5"],
    props: ["ice", "column", "reef", "bones", "arch", "pool"] },
};
const bossLandmarks = { "iron-king": "ironGate", "ember-dragon": "emberAltar" };
const weatherNames = { clear: "晴朗", dusk: "暮色", mist: "薄雾" };

function randomFor(key) {
  let state = 2166136261;
  for (const character of key) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function selectScenery(run) {
  const { floor, enemy } = run;
  // Older saves have no scenery seed. Use a stable key independent of evolution and player actions.
  const seed = run.scenerySeed ?? "legacy";
  const chapter = Math.floor((floor - 1) / 5);
  const order = shuffle(Object.keys(biomes), randomFor(`${seed}:biomes`));
  const biome = order[chapter % order.length];
  const pool = shuffle(biomes[biome].props, randomFor(`${seed}:${chapter}:props`));
  const kind = enemy.boss ? "boss" : enemy.elite ? "elite" : "normal";
  const offset = ((floor - 1) % 5 + (kind === "boss" ? 1 : 0)) % pool.length;
  const key = `${seed}:${floor}:${enemy.id}:${kind}`;
  const random = randomFor(key);
  const weather = ["clear", "dusk", "mist"][Math.floor(random() * 3)];
  const slots = [0.09, 0.91, 0.49];
  const props = slots.map((position, index) => ({
    kind: pool[(offset + index) % pool.length],
    position: position + (random() - .5) * .045,
    size: (index === 2 ? .61 : 1) * (.88 + random() * .23),
    mirrored: random() < .5,
  }));
  const landmark = enemy.boss ? bossLandmarks[enemy.id] : null;
  return { key, biome, weather, props, landmark,
    label: `${biomes[biome].name} · ${weatherNames[weather]}` };
}

// All shapes use a low-resolution canvas and share the local terrain palette.
function polygon(ctx, color, points) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let index = 2; index < points.length; index += 2) ctx.lineTo(points[index], points[index + 1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function shapes(ctx, colors) {
  const [, , far, dark, stone, shade, light] = colors;
  const rock = (points, highlight) => {
    polygon(ctx, shade, points);
    polygon(ctx, stone, highlight);
  };
  const rect = (color, x, y, width, height) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  };
  const tree = (evergreen) => {
    polygon(ctx, shade, [-8, 0, -4, -15, -3, -36, 3, -37, 5, -14, 9, 0]);
    if (evergreen) {
      polygon(ctx, dark, [-21, -13, -12, -28, -16, -28, -8, -43, -11, -43, 0, -62, 12, -43, 8, -43, 17, -28, 13, -28, 23, -13]);
      polygon(ctx, light, [-16, -24, -6, -32, -11, -33, -2, -46, -6, -46, 0, -57, 9, -43, 4, -43, 14, -32, 1, -36, -4, -25]);
    } else {
      polygon(ctx, dark, [-27, -29, -27, -40, -20, -42, -15, -53, -4, -55, 3, -63, 15, -60, 19, -51, 28, -46, 30, -34, 20, -29, 6, -32, -3, -25, -12, -30]);
      polygon(ctx, stone, [-23, -42, -15, -50, -6, -51, 3, -59, 14, -56, 18, -49, 26, -44, 13, -45, 8, -39, -2, -44, -12, -38]);
    }
  };
  const column = () => {
    rect(shade, -10, -5, 20, 5);
    polygon(ctx, shade, [-8, -5, -7, -39, -3, -44, 5, -42, 9, -36, 8, -5]);
    polygon(ctx, light, [-6, -7, -5, -38, -2, -42, 4, -40, 3, -7]);
    rect(stone, -9, -10, 17, 2);
    rect(far, -2, -33, 2, 15);
  };
  const arch = (iron) => {
    const edge = iron ? "#94999f" : light;
    polygon(ctx, shade, [-27, 0, -27, -29, -15, -44, 14, -44, 27, -30, 27, 0, 18, 0, 18, -26, 10, -35, -10, -35, -18, -26, -18, 0]);
    polygon(ctx, edge, [-26, -4, -26, -28, -14, -42, 14, -42, 25, -29, 25, -4, 21, -4, 21, -27, 12, -38, -12, -38, -22, -26, -22, -4]);
    for (const x of [-27, 17]) {
      rect(stone, x, -9, 10, 3);
      rect(stone, x, -21, 10, 2);
    }
    if (iron) rect("#e2c07d", -3, -43, 6, 6);
  };
  return {
    tree: () => tree(false), pine: () => tree(true), column,
    arch: () => arch(false), ironGate: () => arch(true),
    wall() {
      rock([-26, 0, -26, -21, -17, -21, -17, -28, -6, -28, -6, -22, 9, -22, 9, -15, 20, -15, 20, 0],
        [-24, -19, -15, -19, -15, -26, -8, -26, -8, -20, 7, -20, 7, -13, 18, -13, 18, -10, -24, -10]);
      rect(shade, -11, -19, 2, 8);
      rect(light, -23, -8, 12, 2);
      rect(light, -4, -7, 14, 2);
    },
    log() {
      polygon(ctx, "#56453e", [-24, -6, -19, -15, 15, -22, 23, -19, 26, -10, 20, -4, -16, 0]);
      polygon(ctx, "#826953", [-20, -13, 15, -20, 23, -17, -16, -7]);
      polygon(ctx, "#bb9d75", [-24, -6, -19, -14, -13, -12, -10, -5, -15, 0, -21, -1]);
      rect("#735643", -18, -9, 3, 5);
    },
    roots() {
      polygon(ctx, shade, [-25, 0, -13, -7, -6, -23, -7, -37, 1, -42, 6, -37, 7, -16, 24, -5, 28, 0, 17, -2, 8, -7, 1, -8, -8, -3]);
      polygon(ctx, stone, [-18, -2, -9, -8, -3, -24, -4, -37, 0, -40, 1, -18, -5, -8]);
    },
    fern() {
      polygon(ctx, dark, [-4, 0, -9, -9, -20, -14, -12, -15, -4, -10, -7, -23, -1, -18, 3, -8, 8, -20, 15, -22, 10, -12, 22, -14, 14, -8, 6, 0]);
      rect(light, -2, -13, 2, 11);
    },
    reeds() {
      for (const [x, y] of [[-14, -17], [-8, -23], [0, -27], [10, -19], [16, -13]]) {
        rect(dark, x, y, 2, -y);
        rect(light, x - 1, y, 4, 5);
      }
    },
    wreck() {
      polygon(ctx, "#453f3f", [-32, -14, -21, -7, -9, -10, -2, -6, 12, -13, 27, -23, 22, -7, 11, 0, -22, 0]);
      polygon(ctx, "#866955", [-30, -13, -21, -7, -9, -10, -2, -6, 12, -13, 26, -22, 22, -16, 2, -4, -23, -3]);
      polygon(ctx, "#524438", [-8, -4, -12, -36, -6, -39, -3, -32, -4, -7]);
      polygon(ctx, "#b8afa2", [-6, -35, 12, -23, 10, -20, 3, -24, 0, -21]);
    },
    pier() {
      for (const x of [-21, -10, 11, 20]) rect("#54473f", x, -19, 3, 19);
      polygon(ctx, "#8d7157", [-24, -18, 20, -21, 25, -16, -24, -13]);
      rect("#bb9d75", -22, -17, 45, 2);
    },
    reef() {
      rock([-27, 0, -24, -13, -14, -17, -9, -12, -2, -24, 9, -26, 16, -14, 25, -11, 29, 0],
        [-24, -12, -14, -16, -9, -11, -2, -22, 9, -24, 17, -12, 24, -10, 12, -10, 6, -16, -3, -13, -10, -6]);
    },
    pool() {
      polygon(ctx, dark, [-30, -2, -24, -8, -8, -11, 16, -9, 29, -5, 33, -1, 23, 2, -17, 2]);
      rect(far, -19, -6, 27, 1);
      rect(far, 4, -3, 19, 1);
    },
    bones() {
      polygon(ctx, light, [-24, -3, -13, -7, -8, -4, 9, -4, 16, -8, 21, -5, 24, -1, 19, 1, -21, 1]);
      for (const x of [-9, -1, 7]) polygon(ctx, light, [x - 3, -2, x - 3, -11, x, -15, x + 4, -12, x + 1, -8, x + 1, -2]);
    },
    cactus() {
      polygon(ctx, dark, [-4, 0, -4, -12, -15, -12, -15, -27, -11, -30, -8, -27, -8, -19, -4, -19, -4, -38, 0, -42, 5, -38, 5, -23, 10, -23, 10, -31, 14, -33, 17, -29, 17, -17, 5, -17, 5, 0]);
      rect(far, -2, -37, 2, 35);
    },
    ice() {
      polygon(ctx, dark, [-25, 0, -24, -19, -17, -25, -9, -17, -7, -32, 2, -41, 12, -31, 12, -14, 19, -20, 26, -12, 28, 0]);
      polygon(ctx, light, [-23, -18, -17, -23, -17, -4, -22, -8]);
      polygon(ctx, light, [-5, -31, 2, -39, 2, -13, -5, -17]);
      polygon(ctx, far, [3, -39, 10, -31, 10, -16, 3, -13]);
      polygon(ctx, light, [14, -10, 19, -18, 20, -3]);
    },
    emberAltar() {
      rect(shade, -24, -5, 48, 5);
      rect(stone, -18, -11, 36, 6);
      polygon(ctx, shade, [-18, -11, -22, -21, 22, -21, 18, -11]);
      polygon(ctx, "#bb543f", [-18, -21, -13, -33, -8, -30, -4, -44, 3, -35, 8, -39, 13, -26, 18, -24, 18, -21]);
      polygon(ctx, "#f6b66b", [-10, -21, -6, -32, -1, -28, 3, -35, 9, -21]);
    },
  };
}

function drawScene(ctx, width, scene) {
  const height = ctx.canvas.height;
  const colors = biomes[scene.biome].colors;
  const [sky, horizon, far, near, ground, shade, light] = colors;
  const random = randomFor(`${scene.key}:texture`);
  const gradient = ctx.createLinearGradient(0, 0, 0, 65);
  gradient.addColorStop(0, scene.weather === "dusk" ? "#34303e" : sky);
  gradient.addColorStop(1, scene.weather === "dusk" ? "#c39078" : horizon);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const ridge = [0, height];
  const flatHorizon = scene.biome === "coast" || scene.biome === "marsh";
  for (let x = 0; x < width; x += 13) ridge.push(x, flatHorizon ? 47 : 25 + Math.floor(random() * 25));
  ridge.push(width, flatHorizon ? 47 : 36, width, height);
  polygon(ctx, far, ridge);
  polygon(ctx, near, [0, 58, width * .19, 54, width * .41, 57, width * .63, 52, width * .82, 56, width, 54, width, height, 0, height]);

  const art = shapes(ctx, colors);
  if (scene.biome === "forest" || scene.biome === "snow") {
    for (let x = 0; x < width; x += 21) {
      ctx.save();
      ctx.translate(x + random() * 10, 63);
      ctx.scale(.48, .48);
      ctx.globalAlpha = .48;
      art[scene.biome === "forest" ? "tree" : "pine"]();
      ctx.restore();
    }
  } else if (scene.biome === "cavern") {
    polygon(ctx, sky, [0, 0, width, 0, width, 38, width * .86, 6, width * .75, 24, width * .70, 7,
      width * .52, 11, width * .46, 24, width * .43, 4, width * .24, 9, width * .18, 26, width * .12, 10, 0, 34]);
  } else if (flatHorizon) {
    ctx.fillStyle = horizon;
    for (let index = 0; index < 16; index++) ctx.fillRect(random() * width, 48 + random() * 16, 4 + random() * 12, 1);
    if (scene.biome === "marsh") {
      for (let x = 6; x < width; x += 28) {
        ctx.save();
        ctx.translate(x + random() * 12, 63);
        ctx.scale(.47, .47);
        ctx.globalAlpha = .72;
        art.reeds();
        ctx.restore();
      }
    }
  }

  polygon(ctx, ground, [0, 68, width * .21, 64, width * .39, 65, width * .66, 62, width * .83, 65, width, 64, width, height, 0, height]);
  polygon(ctx, light, [0, 79, width * .23, 73, width * .45, 74, width * .71, 71, width, 76,
    width, 80, width * .71, 76, width * .44, 79, width * .22, 78, 0, 85]);
  for (let index = 0; index < 40; index++) {
    ctx.fillStyle = index % 3 ? shade : light;
    ctx.fillRect(Math.round(random() * width), 66 + Math.floor(random() * 34), 1 + Math.floor(random() * 9), 1);
  }

  for (const [index, prop] of scene.props.entries()) {
    if (index === 2 && scene.landmark) continue;
    ctx.save();
    ctx.translate(Math.round(prop.position * width), index === 2 ? 64 : 83);
    const scale = Math.min(1, width / 205) * prop.size;
    ctx.scale(prop.mirrored ? -scale : scale, scale);
    art[prop.kind]();
    ctx.restore();
  }
  if (scene.landmark) {
    ctx.save();
    ctx.translate(Math.round(width / 2), 69);
    art[scene.landmark]();
    ctx.restore();
  }
  if (scene.weather === "mist") {
    const haze = ctx.createLinearGradient(0, 37, 0, 86);
    haze.addColorStop(0, "#d7e4dd00");
    haze.addColorStop(.55, "#d7e4dd72");
    haze.addColorStop(1, "#d7e4dd00");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 37, width, 49);
  } else if (scene.weather === "dusk") {
    ctx.fillStyle = "#45305138";
    ctx.fillRect(0, 0, width, height);
  }

  // Ground-level accents stay at the canvas edge, away from the sprites and hit effects.
  polygon(ctx, shade, [0, 100, 0, 92, 9, 92, 15, 97, 24, 100]);
  polygon(ctx, shade, [width, 100, width, 90, width - 7, 92, width - 13, 96, width - 21, 100]);
}

export function createScenery(canvas, caption) {
  const ctx = canvas.getContext("2d");
  let scene;
  function paint() {
    if (!scene || !ctx || !canvas.clientHeight) return;
    const width = Math.round(100 * canvas.clientWidth / canvas.clientHeight);
    if (width < 1) return;
    canvas.width = width;
    canvas.height = 100;
    drawScene(ctx, width, scene);
  }
  new ResizeObserver(paint).observe(canvas);
  return (run) => {
    const next = selectScenery(run);
    if (scene?.key === next.key) return;
    scene = next;
    caption.textContent = scene.label;
    paint();
  };
}
