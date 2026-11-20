// Only these display values can travel in the public room snapshot.
export const adventureRewards = [
  { id: 'first-boss', name: '首领之印', kind: 'effect', boss: 'iron-king' },
  { id: 'second-boss', name: '星辉降临', kind: 'effect', boss: 'ember-dragon' },
  { id: 'trailblazer', name: '拓路者', kind: 'title', floor: 5 },
  { id: 'veteran', name: '无尽行者', kind: 'title', floor: 10 },
  { id: 'pathfinder', name: '深境领航者', kind: 'title', floor: 25 },
  { id: 'guardian', name: '护壁行者', kind: 'title', upgrade: 'bastion' },
];

export function displayReward(kind, name) {
  return adventureRewards.some((reward) => reward.kind === kind && reward.name === name);
}
