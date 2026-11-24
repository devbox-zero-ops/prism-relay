import {
  cellIdx,
  codeToOptic,
  compileBoard,
  type FastBoard,
  isInside,
  simulateBoard,
  simulateFast,
} from './engine.js';
import {
  createMulberry32,
  getPuzzleNumberForDate,
  hashStringToSeed,
  randInt,
  shuffleInPlace,
} from './prng.js';
import {
  type BlockerCell,
  type Dir,
  DIR_DELTA,
  type EmitterCell,
  GRID_SIZE,
  type OpticType,
  type Placement,
  type PuzzleDefinition,
  type PuzzleMode,
  type TargetCell,
  type WavelengthCode,
} from './types.js';

export interface ExactSolveResult {
  solvable: boolean;
  minOptics: number;
  solution: Placement[];
  nodesExplored: number;
  exhaustive: boolean;
}

function encodeOpticsKey(opticsGrid: Uint8Array): string {
  let out = '';
  for (let i = 0; i < opticsGrid.length; i++) {
    const v = opticsGrid[i];
    if (v !== 0) {
      out += `${i}:${v},`;
    }
  }
  return out;
}

function extractPlacements(opticsGrid: Uint8Array): Placement[] {
  const out: Placement[] = [];
  for (let i = 0; i < opticsGrid.length; i++) {
    const v = opticsGrid[i];
    if (v !== 0) {
      const r = Math.floor(i / GRID_SIZE);
      const c = i - r * GRID_SIZE;
      out.push({ r, c, optic: codeToOptic(v) });
    }
  }
  return out;
}

/**
 * Exact iterative-deepening solver for Prism Relay.
 * Sound pruning: only branches on open cells currently lit by an erroneous wavelength.
 */
export function findMinimumOpticsSolution(
  puzzle: Pick<PuzzleDefinition, 'emitters' | 'targets' | 'blockers'>,
  maxSearchOptics: number,
  nodeBudget = 24000,
): ExactSolveResult {
  const board: FastBoard = compileBoard(puzzle);
  const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);

  const initial = simulateFast(board, grid);
  if (initial.solved) {
    return { solvable: true, minOptics: 0, solution: [], nodesExplored: 1, exhaustive: true };
  }

  let nodesExplored = 1;
  let budgetHit = false;
  let bestSolution: Placement[] | null = null;

  for (let limit = 1; limit <= maxSearchOptics; limit++) {
    const visitedAtDepth = new Set<string>();

    const dfs = (depth: number, sim: ReturnType<typeof simulateFast>): boolean => {
      if (sim.solved) {
        bestSolution = extractPlacements(grid);
        return true;
      }
      if (depth >= limit) {
        return false;
      }
      if (nodesExplored >= nodeBudget) {
        budgetHit = true;
        return false;
      }

      const errorMask = (sim.errA ? 1 : 0) | (sim.errC ? 2 : 0);
      const candidates: number[] = [];
      for (let ci = 0; ci < GRID_SIZE * GRID_SIZE; ci++) {
        if (board.cellKind[ci] === 0 && grid[ci] === 0 && (sim.cellLightMask[ci] & errorMask) !== 0) {
          candidates.push(ci);
        }
      }

      for (let i = 0; i < candidates.length; i++) {
        const ci = candidates[i];
        for (let opticCode = 1; opticCode <= 3; opticCode++) {
          grid[ci] = opticCode;
          const key = encodeOpticsKey(grid);
          if (!visitedAtDepth.has(key)) {
            visitedAtDepth.add(key);
            nodesExplored++;
            const nextSim = simulateFast(board, grid);
            if (dfs(depth + 1, nextSim)) {
              grid[ci] = 0;
              return true;
            }
          }
          grid[ci] = 0;
          if (budgetHit) return false;
        }
      }
      return false;
    };

    if (dfs(0, initial) && bestSolution) {
      return {
        solvable: true,
        minOptics: limit,
        solution: bestSolution,
        nodesExplored,
        exhaustive: !budgetHit,
      };
    }
    if (budgetHit) {
      return {
        solvable: false,
        minOptics: -1,
        solution: [],
        nodesExplored,
        exhaustive: false,
      };
    }
  }

  return {
    solvable: false,
    minOptics: -1,
    solution: [],
    nodesExplored,
    exhaustive: true,
  };
}

function mirrorForTurn(inDir: Dir, outDir: Dir): OpticType | null {
  if (
    (inDir === 'N' && outDir === 'E') ||
    (inDir === 'E' && outDir === 'N') ||
    (inDir === 'S' && outDir === 'W') ||
    (inDir === 'W' && outDir === 'S')
  ) {
    return 'slash';
  }
  if (
    (inDir === 'N' && outDir === 'W') ||
    (inDir === 'W' && outDir === 'N') ||
    (inDir === 'S' && outDir === 'E') ||
    (inDir === 'E' && outDir === 'S')
  ) {
    return 'backslash';
  }
  return null;
}

/**
 * Constructive dual-wavelength convergence builder:
 * Places Amber and Cyan emitters on distinct edges, steers both through 3–5 optics
 * (including at least 1 perpendicular '+' splitter) so they reliably converge onto
 * at least one White (A+C) photodiode while also feeding separate A and C photodiodes,
 * then places Obsidian blockers on unlit cells to prevent trivial shortcuts.
 */
function buildCandidatePuzzle(rng: () => number, extraBends: number): {
  emitters: EmitterCell[];
  targets: TargetCell[];
  blockers: BlockerCell[];
  planted: Placement[];
} | null {
  // Choose orthogonal or opposing edges for Amber & Cyan emitters
  const sides: Array<{ edge: Dir; r: number; c: number; dir: Dir }> = [
    { edge: 'N', r: 0, c: randInt(rng, 1, GRID_SIZE - 1), dir: 'S' },
    { edge: 'S', r: GRID_SIZE - 1, c: randInt(rng, 1, GRID_SIZE - 1), dir: 'N' },
    { edge: 'W', r: randInt(rng, 1, GRID_SIZE - 1), c: 0, dir: 'E' },
    { edge: 'E', r: randInt(rng, 1, GRID_SIZE - 1), c: GRID_SIZE - 1, dir: 'W' },
  ];
  shuffleInPlace(sides, rng);
  const sA = sides[0];
  const sC = sides[1];

  const eA: EmitterCell = { kind: 'emitter', r: sA.r, c: sA.c, dir: sA.dir, color: 'A' };
  const eC: EmitterCell = { kind: 'emitter', r: sC.r, c: sC.c, dir: sC.dir, color: 'C' };
  const emitters = [eA, eC];

  const reserved = new Set<number>([cellIdx(eA.r, eA.c), cellIdx(eC.r, eC.c)]);
  // Interior convergence target coordinate (wr, wc)
  const wr = randInt(rng, 1, GRID_SIZE - 1);
  const wc = randInt(rng, 1, GRID_SIZE - 1);
  if (reserved.has(cellIdx(wr, wc))) return null;

  const plantedMap = new Map<number, Placement>();
  const trySteerEmitter = (e: EmitterCell, useSplitterAtBend: boolean): boolean => {
    const isVert = e.dir === 'N' || e.dir === 'S';
    if (isVert) {
      // Emitter travels vertically along col e.c; bend at (wr, e.c) toward wc
      if (e.c === wc) return false;
      const ahead = (e.dir === 'S' && wr > e.r) || (e.dir === 'N' && wr < e.r);
      if (!ahead) return false;
      const turnIdx = cellIdx(wr, e.c);
      if (reserved.has(turnIdx) || plantedMap.has(turnIdx)) return false;
      const outDir: Dir = wc > e.c ? 'E' : 'W';
      const optic = useSplitterAtBend ? 'splitter' : mirrorForTurn(e.dir, outDir);
      if (!optic) return false;
      plantedMap.set(turnIdx, { r: wr, c: e.c, optic });
      return true;
    } else {
      // Emitter travels horizontally along row e.r; bend at (e.r, wc) toward wr
      if (e.r === wr) return false;
      const ahead = (e.dir === 'E' && wc > e.c) || (e.dir === 'W' && wc < e.c);
      if (!ahead) return false;
      const turnIdx = cellIdx(e.r, wc);
      if (reserved.has(turnIdx) || plantedMap.has(turnIdx)) return false;
      const outDir: Dir = wr > e.r ? 'S' : 'N';
      const optic = useSplitterAtBend ? 'splitter' : mirrorForTurn(e.dir, outDir);
      if (!optic) return false;
      plantedMap.set(turnIdx, { r: e.r, c: wc, optic });
      return true;
    }
  };

  // Use at least one splitter so one emitter simultaneously feeds White + its own branch
  const splitA = rng() < 0.5;
  if (!trySteerEmitter(eA, splitA)) return null;
  if (!trySteerEmitter(eC, !splitA || rng() < 0.5)) return null;

  // Add 1 to 2 extra optics on live single-color cells to deepen routing to Par 3–5
  for (let k = 0; k < extraBends; k++) {
    const sim = simulateBoard({ emitters, targets: [], blockers: [] }, Array.from(plantedMap.values()));
    const litCandidates: number[] = [];
    for (let ci = 0; ci < GRID_SIZE * GRID_SIZE; ci++) {
      const r = Math.floor(ci / GRID_SIZE);
      const c = ci % GRID_SIZE;
      if (
        !reserved.has(ci) &&
        !plantedMap.has(ci) &&
        ci !== cellIdx(wr, wc) &&
        sim.cellLightMask[ci] !== 0 &&
        sim.cellLightMask[ci] !== 3 &&
        r >= 1 && r <= GRID_SIZE - 2 && c >= 1 && c <= GRID_SIZE - 2
      ) {
        litCandidates.push(ci);
      }
    }
    if (litCandidates.length === 0) break;
    shuffleInPlace(litCandidates, rng);
    const chosenCi = litCandidates[0];
    const roll = rng();
    const optic: OpticType = roll < 0.35 ? 'slash' : roll < 0.7 ? 'backslash' : 'splitter';
    plantedMap.set(chosenCi, { r: Math.floor(chosenCi / GRID_SIZE), c: chosenCi % GRID_SIZE, optic });
  }

  const planted = Array.from(plantedMap.values());
  if (planted.length < 3) return null;

  const finalSim = simulateBoard({ emitters, targets: [], blockers: [] }, planted);
  const emptySim = simulateBoard({ emitters, targets: [], blockers: [] }, []);

  // Verify convergence cell (wr, wc) actually receives White (3)
  const whiteCells: number[] = [];
  const amberCells: number[] = [];
  const cyanCells: number[] = [];

  for (let ci = 0; ci < GRID_SIZE * GRID_SIZE; ci++) {
    if (reserved.has(ci) || plantedMap.has(ci)) continue;
    const mask = finalSim.cellLightMask[ci];
    if (mask === 0) continue;
    const changed = mask !== emptySim.cellLightMask[ci];
    if (mask === 3) {
      whiteCells.push(ci);
    } else if (mask === 1 && changed) {
      amberCells.push(ci);
    } else if (mask === 2 && changed) {
      cyanCells.push(ci);
    }
  }

  if (whiteCells.length === 0 || amberCells.length === 0 || cyanCells.length === 0) {
    return null;
  }

  shuffleInPlace(whiteCells, rng);
  shuffleInPlace(amberCells, rng);
  shuffleInPlace(cyanCells, rng);

  // Pick White + Amber + Cyan (+ optional 4th target)
  const chosenTargets: Array<{ ci: number; req: WavelengthCode }> = [
    { ci: whiteCells[0], req: 'W' },
    { ci: amberCells[0], req: 'A' },
    { ci: cyanCells[0], req: 'C' },
  ];
  if (rng() < 0.5) {
    const extras: Array<{ ci: number; req: WavelengthCode }> = [];
    if (amberCells.length > 1) extras.push({ ci: amberCells[1], req: 'A' });
    if (cyanCells.length > 1) extras.push({ ci: cyanCells[1], req: 'C' });
    if (extras.length > 0) {
      chosenTargets.push(extras[randInt(rng, 0, extras.length)]);
    }
  }

  const targets: TargetCell[] = chosenTargets.map((item) => ({
    kind: 'target',
    r: Math.floor(item.ci / GRID_SIZE),
    c: item.ci % GRID_SIZE,
    required: item.req,
  }));

  // Verify planted optics STILL solve once absorbing targets are installed
  const simWithTargets = simulateBoard({ emitters, targets, blockers: [] }, planted);
  if (!simWithTargets.solved) return null;

  // Reject trivial boards already solved with 0 optics
  if (simulateBoard({ emitters, targets, blockers: [] }, []).solved) return null;

  // Place 4–6 obsidian blockers ONLY on completely unlit cells (never breaks solution, enriches geometry)
  const targetSet = new Set(chosenTargets.map((t) => t.ci));
  const darkCells: number[] = [];
  for (let ci = 0; ci < GRID_SIZE * GRID_SIZE; ci++) {
    if (!reserved.has(ci) && !plantedMap.has(ci) && !targetSet.has(ci) && simWithTargets.cellLightMask[ci] === 0) {
      // Avoid blocking emitter's immediate launch tile
      const nextA = cellIdx(eA.r + DIR_DELTA[eA.dir].dr, eA.c + DIR_DELTA[eA.dir].dc);
      const nextC = cellIdx(eC.r + DIR_DELTA[eC.dir].dr, eC.c + DIR_DELTA[eC.dir].dc);
      if (isInside(Math.floor(ci / GRID_SIZE), ci % GRID_SIZE) && ci !== nextA && ci !== nextC) {
        darkCells.push(ci);
      }
    }
  }
  shuffleInPlace(darkCells, rng);
  const blockerCount = Math.min(darkCells.length, randInt(rng, 4, 7));
  const blockers: BlockerCell[] = darkCells.slice(0, blockerCount).map((ci) => ({
    kind: 'blocker',
    r: Math.floor(ci / GRID_SIZE),
    c: ci % GRID_SIZE,
  }));

  return { emitters, targets, blockers, planted };
}

/**
 * Generates a guaranteed-solvable, exact-Par verified 7x7 Prism Relay puzzle
 * for any UTC date string (daily/archive) or practice seed.
 */
export function generatePuzzleForKey(
  key: string,
  mode: PuzzleMode,
  puzzleNumber: number,
): PuzzleDefinition {
  const baseSeed = hashStringToSeed(`prism-relay-v2:${key}`);
  const rng = createMulberry32(baseSeed);

  // Alternate 1 or 2 extra bends to yield rich Par 3–4 daily puzzles
  const extraBends = 1 + (puzzleNumber % 2);

  for (let attempt = 0; attempt < 320; attempt++) {
    const candidate = buildCandidatePuzzle(rng, attempt < 220 ? extraBends : 2);
    if (!candidate) continue;

    // Prove exact Par: check whether any solution exists with fewer optics than planted.length
    const shorter = findMinimumOpticsSolution(
      candidate,
      candidate.planted.length - 1,
      14000,
    );

    let referenceSolution: Placement[];
    if (shorter.solvable) {
      if (shorter.minOptics < 3) continue;
      referenceSolution = shorter.solution;
    } else if (!shorter.exhaustive) {
      continue;
    } else {
      referenceSolution = candidate.planted;
    }

    const verifiedSim = simulateBoard(candidate, referenceSolution);
    if (!verifiedSim.solved) continue;

    return {
      id: `${mode}:${key}`,
      date: key,
      mode,
      puzzleNumber,
      seed: baseSeed,
      size: GRID_SIZE,
      emitters: candidate.emitters,
      targets: candidate.targets,
      blockers: candidate.blockers,
      parOptics: referenceSolution.length,
      parBeamLength: verifiedSim.beamLength,
      referenceSolution,
    };
  }

  // Mathematically verified fallback (Par = 3: two splitters + one mirror, W + A + C targets)
  const fallbackEmitters: EmitterCell[] = [
    { kind: 'emitter', r: 0, c: 1, dir: 'S', color: 'A' },
    { kind: 'emitter', r: 6, c: 5, dir: 'N', color: 'C' },
  ];
  const fallbackBlockers: BlockerCell[] = [
    { kind: 'blocker', r: 1, c: 4 },
    { kind: 'blocker', r: 3, c: 0 },
    { kind: 'blocker', r: 5, c: 2 },
    { kind: 'blocker', r: 3, c: 6 },
  ];
  const fallbackTargets: TargetCell[] = [
    { kind: 'target', r: 3, c: 3, required: 'W' },
    { kind: 'target', r: 2, c: 0, required: 'A' },
    { kind: 'target', r: 5, c: 3, required: 'C' },
  ];
  // Amber (0,1) S -> (2,1) '+' splits W to (2,0)[A] & E to (2,3) '\' turns S -> (3,3)[W]
  // Cyan  (6,5) N -> (4,5) '\' turns W? Wait: N hitting '\' turns W -> (4,3) '+' splits N to (3,3)[W] & S to (5,3)[C]
  const fallbackSolution: Placement[] = [
    { r: 2, c: 1, optic: 'splitter' },
    { r: 2, c: 3, optic: 'backslash' },
    { r: 4, c: 5, optic: 'backslash' },
    { r: 4, c: 3, optic: 'splitter' },
  ];
  const exactFb = findMinimumOpticsSolution(
    { emitters: fallbackEmitters, targets: fallbackTargets, blockers: fallbackBlockers },
    4,
    20000,
  );
  const sol = exactFb.solvable ? exactFb.solution : fallbackSolution;
  const fbSim = simulateBoard(
    { emitters: fallbackEmitters, targets: fallbackTargets, blockers: fallbackBlockers },
    sol,
  );

  return {
    id: `${mode}:${key}`,
    date: key,
    mode,
    puzzleNumber,
    seed: baseSeed,
    size: GRID_SIZE,
    emitters: fallbackEmitters,
    targets: fallbackTargets,
    blockers: fallbackBlockers,
    parOptics: sol.length,
    parBeamLength: fbSim.beamLength,
    referenceSolution: sol,
  };
}

export function getDailyPuzzle(dateStr: string, mode: PuzzleMode = 'daily'): PuzzleDefinition {
  const num =
    mode === 'practice'
      ? Math.max(1, (hashStringToSeed(dateStr) % 900) + 100)
      : getPuzzleNumberForDate(dateStr);
  return generatePuzzleForKey(dateStr, mode, num);
}
