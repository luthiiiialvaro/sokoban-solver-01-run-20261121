// Sokoban solver for make.fun's sokoban-solver-01 bounty.
// Written fresh for this entry: a push-level A* search, one room at a time.
//
// How it works:
// - Every generated level is a 1-wide hallway with 1-4 rooms off it (6x6 slots,
//   one door each). A box pushed through a door can never come back, so each
//   room is an independent problem and the level's push-optimum is the sum of
//   the rooms' optima. The solver finds the rooms (connected floor components
//   once the hallway's dead squares are cut out), solves each room on its own
//   with the other rooms' boxes treated as walls, and stitches the walks and
//   pushes together in room order.
// - Inside a room the search is A* over pushes. A state is the boxes' squares
//   plus the player's reachable region (named by its lowest square). The
//   heuristic is the minimum-cost assignment of boxes to goals, where the cost
//   of a box to a goal is its shortest walking distance (walls only): every
//   push moves one box one square, so the assignment cost never overestimates
//   the pushes left, and A* returns a push-optimal room solution.
// - Deadlock pruning: a box on a square no pull-back from any goal reaches
//   (a "dead square") can never be saved, and a box inside a frozen 2x2 block
//   of walls and boxes can never move. Both prunings are safe: they never cut
//   a solvable state.
// - Determinism: fixed direction order, a heap ordered by (f, deeper g first,
//   insertion order), and budgets counted in expanded states, never in wall
//   clock time. Two runs on the same input write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** A* expansions allowed per room before the greedy fallback is tried. */
const ASTAR_BUDGET = 400_000;
/** Greedy best-first expansions allowed per room as a fallback. */
const GREEDY_BUDGET = 200_000;

interface Step {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  boxes: number[];
  goals: number[];
  firstCell: number;
  done: boolean;
}

interface Found {
  moves: string;
  pushes: number;
  endPlayer: number;
}

/** Parse an XSB level: '#' wall, ' ' floor, '.' goal, '$' box, '*' box on a goal, '@' player, '+' player on a goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // Nothing leaves the board: the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box can still be pushed onto some goal. Pull boxes
 * back from the goals: a box at y can be pulled to a live square x = y + d
 * only when the player can stand at y - d, the square behind it.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const s of STEPS) {
      const d = s.dy * w + s.dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from `from` over open floor (walls only, boxes ignored). */
function walkingDistances(board: Board, from: number): Int32Array {
  const dist = new Int32Array(board.wall.length).fill(-1);
  const queue: number[] = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const s of STEPS) {
      const q = p + s.dy * board.w + s.dx;
      if (!board.wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Flood the player's reachable region (walls and boxes block it) from `from`,
 * marking `seen` with `stamp`; returns the region's lowest square, which names
 * the region: two states with the same boxes and the same reachable region are
 * the same state for every push that follows.
 */
function regionLow(board: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number): number {
  const stack: number[] = [from];
  seen[from] = stamp;
  let low = from;
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p < low) low = p;
    for (const s of STEPS) {
      const q = p + s.dy * board.w + s.dx;
      if (!board.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack.push(q);
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, or null. */
function walkBetween(board: Board, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(board.wall.length).fill(-1);
  const how: string[] = new Array(board.wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const s of STEPS) {
      const q = p + s.dy * board.w + s.dx;
      if (board.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = s.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = how[p] + out;
  return out;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares
 * of walls and boxes, one of them a box off its goal. No box in such a block
 * can be pushed out of it (both push directions are blocked and both squares
 * the player would stand on are taken), so the state is dead.
 */
function frozenBlock(board: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = board.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!((board.wall[a] || occupied[a]) && (board.wall[b] || occupied[b]) && (board.wall[c] || occupied[c]) && (board.wall[d] || occupied[d]))) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

function popcount(n: number): number {
  let c = 0;
  while (n > 0) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}

/**
 * The cheapest way to match every box to a different goal by walking distance
 * (bitmask DP over the goals, boxes in fixed order). Admissible: each box must
 * travel at least its distance to its goal, and each push moves one box one
 * square. Infinity when some box reaches no goal at all.
 */
function assignmentCost(dist: Int32Array[], boxes: number[]): number {
  const n = boxes.length;
  const full = (1 << n) - 1;
  const dp = new Float64Array(1 << n).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask <= full; mask++) {
    const k = popcount(mask);
    if (k >= n || dp[mask] === Infinity) continue;
    for (let gi = 0; gi < n; gi++) {
      if (mask & (1 << gi)) continue;
      const d = dist[gi][boxes[k]];
      if (d < 0) continue;
      const next = mask | (1 << gi);
      const v = dp[mask] + d;
      if (v < dp[next]) dp[next] = v;
    }
  }
  return dp[full];
}

/** Weaker but cheap admissible estimate for wide boards: each box's nearest goal. */
function nearestGoalCost(dist: Int32Array[], boxes: number[]): number {
  let total = 0;
  for (const b of boxes) {
    let best = Infinity;
    for (const dg of dist) {
      const d = dg[b];
      if (d >= 0 && d < best) best = d;
    }
    if (best === Infinity) return Infinity;
    total += best;
  }
  return total;
}

interface Push {
  box: number;
  dir: number;
}

interface State {
  boxes: number[];
  player: number;
  parent: number;
  push: Push | null;
  g: number;
}

/**
 * Push-optimal search over one board (a room, or a whole level as a fallback).
 * A* on pushes with the assignment heuristic; when `greedy` is set it orders
 * the open list by the heuristic alone, which finds some solution fast when
 * the optimal search runs out of budget. Returns null when the budget runs out
 * or the board cannot be solved.
 */
function searchBoard(board: Board, budget: number, greedy: boolean): Found | null {
  const size = board.wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of board.goals) goalSet[g] = 1;
  const live = liveSquares(board);
  if (board.boxes.some((b) => !live[b])) return null;
  const dist = board.goals.map((g) => walkingDistances(board, g));
  const useAssignment = board.boxes.length <= 5 && board.boxes.length === board.goals.length;
  const estimate = (boxes: number[]): number => (useAssignment ? assignmentCost(dist, boxes) : nearestGoalCost(dist, boxes));
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // A state's key: the boxes packed base-256 (boards here are under 256
  // squares) times 256 plus the region's lowest square; wider boards or more
  // than four boxes fall back to a string key.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (boxes.length <= 4 && size <= 256) {
      let packed = 0;
      for (let i = boxes.length - 1; i >= 0; i--) packed = packed * 256 + boxes[i];
      return packed * 256 + low;
    }
    return boxes.join(',') + '|' + low;
  };

  const states: State[] = [{ boxes: board.boxes.slice(), player: board.player, parent: -1, push: null, g: 0 }];
  // Open list: a binary heap of [f, g, sequence, state index, key], ordered by
  // lowest f, then deepest g, then earliest insertion.
  const heap: (number | string)[][] = [];
  const order = (a: (number | string)[], b: (number | string)[]): number =>
    (a[0] as number) - (b[0] as number) || (b[1] as number) - (a[1] as number) || (a[2] as number) - (b[2] as number);
  const heapPush = (entry: (number | string)[]): void => {
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (order(heap[i]!, heap[p]!) >= 0) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): (number | string)[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && order(heap[c + 1]!, heap[c]!) < 0) c++;
        if (order(heap[c]!, heap[i]!) >= 0) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  // Two stamp arrays: regionSeen names the state being expanded (its
  // membership is read while successors are made), lowSeen is scratch for the
  // successors' own region lows. They must not share one array: a successor's
  // flood would otherwise overwrite the current region's marks.
  const regionSeen = new Int32Array(size);
  const lowSeen = new Int32Array(size);
  let regionTick = 0;
  let lowTick = 0;
  const best = new Map<number | string, number>();
  const h0 = estimate(board.boxes);
  if (!Number.isFinite(h0)) return null;
  for (const b of board.boxes) occupied[b] = 1;
  const low0 = regionLow(board, occupied, board.player, lowSeen, ++lowTick);
  for (const b of board.boxes) occupied[b] = 0;
  const key0 = keyOf(board.boxes, low0);
  best.set(key0, 0);
  let sequence = 0;
  heapPush([greedy ? h0 : h0, 0, sequence++, 0, key0]);

  let expanded = 0;
  while (heap.length > 0) {
    const entry = heapPop();
    const si = entry[3] as number;
    if (best.get(entry[4] as number | string) !== (entry[1] as number)) continue;
    const state = states[si]!;
    if (solved(state.boxes)) {
      // Rebuild the moves: walk to each push's square, then push.
      const pushes: Push[] = [];
      for (let s = si; states[s]!.push !== null; s = states[s]!.parent) pushes.push(states[s]!.push!);
      pushes.reverse();
      let moves = '';
      let player = board.player;
      let boxes = board.boxes.slice();
      for (const p of pushes) {
        const step = STEPS[p.dir]!;
        const delta = step.dy * board.w + step.dx;
        for (const b of boxes) occupied[b] = 1;
        const walk = walkBetween(board, occupied, player, p.box - delta);
        for (const b of boxes) occupied[b] = 0;
        if (walk === null) return null;
        moves += walk + step.push;
        player = p.box;
        boxes = boxes.map((b) => (b === p.box ? b + delta : b)).sort((a, b) => a - b);
      }
      return { moves, pushes: pushes.length, endPlayer: player };
    }
    if (expanded >= budget) return null;
    expanded++;
    for (const b of state.boxes) occupied[b] = 1;
    const regionStamp = ++regionTick;
    regionLow(board, occupied, state.player, regionSeen, regionStamp);
    for (let bi = 0; bi < state.boxes.length; bi++) {
      const b = state.boxes[bi];
      for (let di = 0; di < STEPS.length; di++) {
        const step = STEPS[di]!;
        const delta = step.dy * board.w + step.dx;
        const dest = b + delta;
        if (board.wall[dest] || occupied[dest] || !live[dest]) continue;
        const behind = b - delta;
        if (regionSeen[behind] !== regionStamp) continue;
        occupied[b] = 0;
        occupied[dest] = 1;
        if (frozenBlock(board, occupied, goalSet, dest)) {
          occupied[dest] = 0;
          occupied[b] = 1;
          continue;
        }
        const nextBoxes = state.boxes.slice();
        nextBoxes[bi] = dest;
        nextBoxes.sort((a, b2) => a - b2);
        const nextLow = regionLow(board, occupied, b, lowSeen, ++lowTick);
        const key = keyOf(nextBoxes, nextLow);
        const g2 = state.g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g2) {
          occupied[dest] = 0;
          occupied[b] = 1;
          continue;
        }
        const h2 = estimate(nextBoxes);
        occupied[dest] = 0;
        occupied[b] = 1;
        if (!Number.isFinite(h2)) continue;
        best.set(key, g2);
        states.push({ boxes: nextBoxes, player: b, parent: si, push: { box: b, dir: di }, g: g2 });
        heapPush([greedy ? h2 : g2 + h2, g2, sequence++, states.length - 1, key]);
      }
    }
    for (const b of state.boxes) occupied[b] = 0;
  }
  return null;
}

/** One board, optimal search first, greedy search as a fallback. */
function solveBoard(board: Board): Found | null {
  return searchBoard(board, ASTAR_BUDGET, false) ?? searchBoard(board, GREEDY_BUDGET, true);
}

/**
 * Split a level into its rooms: cut the hallway row's dead squares (a box
 * there reaches no goal) out of the floor, and each connected part left that
 * holds boxes is a room. Null when the level is no such set of rooms.
 */
function findRooms(level: Board): Room[] | null {
  const live = liveSquares(level);
  const row = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.wall.length);
  for (let x = 0; x < level.w; x++) {
    const c = row * level.w + x;
    if (!level.wall[c] && !live[c]) cut[c] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(level.wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < level.wall.length; s++) {
    if (level.wall[s] || cut[s] || comp[s] >= 0) continue;
    const cells: number[] = [s];
    comp[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      const p = cells[i];
      for (const st of STEPS) {
        const q = p + st.dy * level.w + st.dx;
        if (!level.wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], firstCell: s, done: false });
  }
  for (const b of level.boxes) {
    const c = comp[b];
    if (c < 0) return null;
    rooms[c]!.boxes.push(b);
  }
  for (const g of level.goals) {
    const c = comp[g];
    if (c < 0) return null;
    rooms[c]!.goals.push(g);
  }
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  if (withBoxes.some((r) => r.boxes.length !== r.goals.length)) return null;
  withBoxes.sort((a, b) => a.firstCell - b.firstCell);
  return withBoxes;
}

/** Solve one level: room by room, or whole-board when it has no room structure. */
function solveLevel(level: Board): string {
  const rooms = findRooms(level);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Board = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solveBoard(sub);
      if (solved === null) return '';
      moves += solved.moves;
      player = solved.endPlayer;
      room.done = true;
    }
    return moves;
  }
  const solved = solveBoard(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
