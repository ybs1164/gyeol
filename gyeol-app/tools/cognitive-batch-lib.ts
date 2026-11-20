import { apply, initial, legal, margin, result, rng, type TimeMode } from '@gyeol/core';

export interface CognitiveGamePlan {
  n: number; split: 'train' | 'validation'; mode: TimeMode;
  green: number; brown: number; openingSeed: number; opening: number[]; pair: number;
}

export function makeOpening(seed: number, plies: number): number[] {
  const random = rng(seed);
  let board = initial(), player: 1 | -1 = 1;
  const opening: number[] = [];
  for (let ply = 0; ply < plies; ply++) {
    if (result(board, player)) throw new Error('Terminal opening');
    const moves = legal(board, player).map(action => ({ action, board: apply(board, player, action).board }));
    moves.sort((a, b) => (margin(b.board) - margin(a.board)) * player || a.action - b.action);
    // Randomness supplies external starting positions, never bot decisions.
    const picked = moves[Math.floor(random() * Math.min(12, moves.length))];
    opening.push(picked.action); board = picked.board; player = -player as 1 | -1;
  }
  return opening;
}

/** Every round gives each participant the same opening with both colors. */
export function cognitiveSchedule(count = 1000, rounds = 50, validationRounds = 10): CognitiveGamePlan[] {
  if (count < 2 || count % 2 || !Number.isInteger(count) || !Number.isInteger(rounds) || rounds < 1 ||
      !Number.isInteger(validationRounds) || validationRounds < 0) throw new Error('Invalid schedule');
  const planned: CognitiveGamePlan[] = [];
  const used = new Set<string>();
  const widths = [20, 50, 100, 200, 500, 1000];
  let pair = 0;
  for (let r = 0; r < rounds + validationRounds; r++) {
    const split = r < rounds ? 'train' : 'validation';
    const vr = r - rounds;
    const mode: TimeMode = split === 'train' ? 'blitz' : vr % 5 === 0 ? 'bullet' : vr % 5 === 1 ? 'rapid' : 'blitz';
    const random = rng((split === 'train' ? 0x3c801cd5 : 0x73b9a451) ^ (r * 2654435761));
    const order = Array.from({ length: count }, (_, i) => i);
    const validationWidths = [500, 500, 200, 1000, 100, 1000, 1000, 500, 100, 1000];
    const width = Math.min(count, split === 'train' ? widths[r % widths.length] : validationWidths[vr % validationWidths.length]);
    for (let start = 0; start < count; start += width) {
      const end = Math.min(count, start + width);
      for (let i = end - 1; i > start; i--) {
        const j = start + Math.floor(random() * (i - start + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    for (let i = 0; i < count; i += 2) {
      let openingSeed = (random() * 2 ** 32) >>> 0;
      let opening = makeOpening(openingSeed, [0, 2, 4, 6][(r + i / 2) % 4]);
      let key = '';
      for (let attempt = 0; ; attempt++) {
        key = `${mode}:${Math.min(order[i], order[i + 1])}:${Math.max(order[i], order[i + 1])}:${opening.join(',')}`;
        if (!used.has(key)) break;
        if (attempt >= 1000) throw new Error('Cannot generate distinct openings');
        openingSeed = (random() * 2 ** 32) >>> 0;
        opening = makeOpening(openingSeed, 4 + 2 * (attempt % 2));
      }
      used.add(key);
      for (let color = 0; color < 2; color++) planned.push({ n: planned.length, split, mode,
        green: order[i + color], brown: order[i + 1 - color], openingSeed, opening, pair });
      pair++;
    }
  }
  return planned;
}
