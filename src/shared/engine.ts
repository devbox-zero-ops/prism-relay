import {
  type BeamBit,
  type BeamSegment,
  type ColorMask,
  type Dir,
  DIR_DELTA,
  DIRS,
  emitterToBit,
  GRID_SIZE,
  type OpticType,
  type Placement,
  type PuzzleDefinition,
  type SimulationResult,
  type TargetState,
  wavelengthToMask,
} from './types.js';

export const DIR_INDEX: Record<Dir, number> = { N: 0, E: 1, S: 2, W: 3 };

export function reflectSlash(dir: Dir): Dir {
  // Mirror '/': N<->E, S<->W
  switch (dir) {
    case 'N':
      return 'E';
    case 'E':
      return 'N';
    case 'S':
      return 'W';
    case 'W':
      return 'S';
  }
}

export function reflectBackslash(dir: Dir): Dir {
  // Mirror '\': N<->W, S<->E
  switch (dir) {
    case 'N':
      return 'W';
    case 'W':
      return 'N';
    case 'S':
      return 'E';
    case 'E':
      return 'S';
  }
}

export function splitPerpendicular(dir: Dir): [Dir, Dir] {
  // Beam Splitter '+': emits perpendicular to incoming beam in both directions
  if (dir === 'N' || dir === 'S') {
    return ['W', 'E'];
  }
  return ['N', 'S'];
}

export function outDirsForOptic(dir: Dir, optic: OpticType): Dir[] {
  if (optic === 'slash') return [reflectSlash(dir)];
  if (optic === 'backslash') return [reflectBackslash(dir)];
  return splitPerpendicular(dir);
}

export function cellIdx(r: number, c: number): number {
  return r * GRID_SIZE + c;
}

export function isInside(r: number, c: number): boolean {
  return r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE;
}

/**
 * Compact internal board representation for microsecond-level ray tracing
 * during both interactive rendering and exact minimum-optics search.
 */
export interface FastBoard {
  /** 0 = empty, 1 = blocker, 2 = emitter, 3 = target */
  cellKind: Uint8Array;
  /** Target index at cell, or -1 */
  targetAtCell: Int8Array;
  emitters: Array<{ r: number; c: number; dirIdx: number; bit: BeamBit }>;
  targetRequired: Uint8Array;
}

export function compileBoard(
  puzzle: Pick<PuzzleDefinition, 'emitters' | 'targets' | 'blockers'>,
): FastBoard {
  const cellKind = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const targetAtCell = new Int8Array(GRID_SIZE * GRID_SIZE).fill(-1);

  for (const b of puzzle.blockers) {
    cellKind[cellIdx(b.r, b.c)] = 1;
  }

  const emitters = puzzle.emitters.map((e) => {
    cellKind[cellIdx(e.r, e.c)] = 2;
    return { r: e.r, c: e.c, dirIdx: DIR_INDEX[e.dir], bit: emitterToBit(e.color) };
  });

  const targetRequired = new Uint8Array(puzzle.targets.length);
  puzzle.targets.forEach((t, idx) => {
    const ci = cellIdx(t.r, t.c);
    cellKind[ci] = 3;
    targetAtCell[ci] = idx;
    targetRequired[idx] = wavelengthToMask(t.required);
  });

  return { cellKind, targetAtCell, emitters, targetRequired };
}

/** Optic numeric code for fast typed-array lookup: 0=none, 1=slash, 2=backslash, 3=splitter */
export function opticToCode(optic: OpticType): number {
  if (optic === 'slash') return 1;
  if (optic === 'backslash') return 2;
  return 3;
}

export function codeToOptic(code: number): OpticType {
  if (code === 1) return 'slash';
  if (code === 2) return 'backslash';
  return 'splitter';
}

const SLASH_DIR = new Int8Array([1, 0, 3, 2]); // N(0)->E(1), E(1)->N(0), S(2)->W(3), W(3)->S(2)
const BACKSLASH_DIR = new Int8Array([3, 2, 1, 0]); // N(0)->W(3), E(1)->S(2), S(2)->E(1), W(3)->N(0)
const DR_BY_DIR = new Int8Array([-1, 0, 1, 0]);
const DC_BY_DIR = new Int8Array([0, 1, 0, -1]);

export interface FastSimOutput {
  solved: boolean;
  errA: boolean;
  errC: boolean;
  targetReceived: Uint8Array;
  cellLightMask: Uint8Array;
  steps: number;
  cycleDetected: boolean;
}

/**
 * Allocation-minimal ray tracer used by the exact solver.
 * State space size: 7 * 7 * 4 * 2 = 392 states -> guaranteed O(1) bounded termination.
 */
export function simulateFast(board: FastBoard, opticsGrid: Uint8Array): FastSimOutput {
  const visited = new Uint8Array(GRID_SIZE * GRID_SIZE * 4 * 2);
  const cellLightMask = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const targetReceived = new Uint8Array(board.targetRequired.length);

  // Queue encoded as integers: ((ci << 3) | (dirIdx << 1) | (bit - 1))
  const queue = new Int32Array(GRID_SIZE * GRID_SIZE * 4 * 2 + 16);
  let head = 0;
  let tail = 0;
  let steps = 0;
  let cycleDetected = false;

  for (let i = 0; i < board.emitters.length; i++) {
    const e = board.emitters[i];
    const ci = e.r * GRID_SIZE + e.c;
    const state = (ci << 3) | (e.dirIdx << 1) | (e.bit - 1);
    if (!visited[state]) {
      visited[state] = 1;
      queue[tail++] = state;
    }
  }

  while (head < tail) {
    const state = queue[head++];
    steps++;
    const colorIdx = state & 1;
    const bit = (colorIdx + 1) as BeamBit;
    const dirIdx = (state >> 1) & 3;
    const ci = state >> 3;
    const r = Math.floor(ci / GRID_SIZE);
    const c = ci - r * GRID_SIZE;

    const nr = r + DR_BY_DIR[dirIdx];
    const nc = c + DC_BY_DIR[dirIdx];
    if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) {
      continue;
    }

    const nci = nr * GRID_SIZE + nc;
    const kind = board.cellKind[nci];

    if (kind === 1 || kind === 2) {
      // Blocker or emitter housing absorbs beam
      continue;
    }

    if (kind === 3) {
      // Photodiode target absorbs beam and accumulates wavelength
      const tIdx = board.targetAtCell[nci];
      targetReceived[tIdx] |= bit;
      cellLightMask[nci] |= bit;
      continue;
    }

    // Empty bench cell
    cellLightMask[nci] |= bit;
    const optic = opticsGrid[nci];
    if (optic === 0) {
      const nextState = (nci << 3) | (dirIdx << 1) | colorIdx;
      if (visited[nextState]) {
        cycleDetected = true;
      } else {
        visited[nextState] = 1;
        queue[tail++] = nextState;
      }
    } else if (optic === 1) {
      const nd = SLASH_DIR[dirIdx];
      const nextState = (nci << 3) | (nd << 1) | colorIdx;
      if (visited[nextState]) {
        cycleDetected = true;
      } else {
        visited[nextState] = 1;
        queue[tail++] = nextState;
      }
    } else if (optic === 2) {
      const nd = BACKSLASH_DIR[dirIdx];
      const nextState = (nci << 3) | (nd << 1) | colorIdx;
      if (visited[nextState]) {
        cycleDetected = true;
      } else {
        visited[nextState] = 1;
        queue[tail++] = nextState;
      }
    } else {
      // Splitter '+': perpendicular in both directions
      const nd1 = dirIdx === 0 || dirIdx === 2 ? 3 : 0; // W or N
      const nd2 = dirIdx === 0 || dirIdx === 2 ? 1 : 2; // E or S
      const s1 = (nci << 3) | (nd1 << 1) | colorIdx;
      if (visited[s1]) {
        cycleDetected = true;
      } else {
        visited[s1] = 1;
        queue[tail++] = s1;
      }
      const s2 = (nci << 3) | (nd2 << 1) | colorIdx;
      if (visited[s2]) {
        cycleDetected = true;
      } else {
        visited[s2] = 1;
        queue[tail++] = s2;
      }
    }
  }

  let errA = false;
  let errC = false;
  for (let i = 0; i < board.targetRequired.length; i++) {
    const diff = targetReceived[i] ^ board.targetRequired[i];
    if (diff & 1) errA = true;
    if (diff & 2) errC = true;
  }

  return {
    solved: !errA && !errC,
    errA,
    errC,
    targetReceived,
    cellLightMask,
    steps,
    cycleDetected,
  };
}

/**
 * Full simulation returning merged beam segments, photodiode states, beam length,
 * and cycle detection flag for client rendering & server anti-cheat verification.
 */
export function simulateBoard(
  puzzle: Pick<PuzzleDefinition, 'emitters' | 'targets' | 'blockers'>,
  placements: readonly Placement[],
): SimulationResult {
  const board = compileBoard(puzzle);
  const opticsGrid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  let opticsUsed = 0;

  for (const p of placements) {
    if (!isInside(p.r, p.c)) continue;
    const ci = cellIdx(p.r, p.c);
    if (board.cellKind[ci] !== 0) continue; // Ignore invalid placement on non-empty cells
    if (opticsGrid[ci] === 0) opticsUsed++;
    opticsGrid[ci] = opticToCode(p.optic);
  }

  const visited = new Uint8Array(GRID_SIZE * GRID_SIZE * 4 * 2);
  const cellLightMask = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const targetReceived = new Uint8Array(board.targetRequired.length);

  // Key undirected internal segments to merge Amber + Cyan -> White cleanly
  const segmentMap = new Map<string, BeamSegment>();
  const exitMap = new Map<string, BeamSegment>();

  const queue: Array<{ r: number; c: number; dirIdx: number; bit: BeamBit }> = [];
  let steps = 0;
  let cycleDetected = false;

  for (const e of board.emitters) {
    const ci = cellIdx(e.r, e.c);
    const state = (ci << 3) | (e.dirIdx << 1) | (e.bit - 1);
    if (!visited[state]) {
      visited[state] = 1;
      cellLightMask[ci] |= e.bit;
      queue.push({ r: e.r, c: e.c, dirIdx: e.dirIdx, bit: e.bit });
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    steps++;
    const dir = DIRS[cur.dirIdx];
    const delta = DIR_DELTA[dir];
    const nr = cur.r + delta.dr;
    const nc = cur.c + delta.dc;

    if (!isInside(nr, nc)) {
      const exitKey = `${cur.r},${cur.c},${dir}`;
      const existing = exitMap.get(exitKey);
      if (existing) {
        existing.mask = (existing.mask | cur.bit) as ColorMask;
      } else {
        exitMap.set(exitKey, {
          r1: cur.r,
          c1: cur.c,
          r2: cur.r + delta.dr * 0.52,
          c2: cur.c + delta.dc * 0.52,
          mask: cur.bit,
          isEdgeExit: true,
          exitDir: dir,
        });
      }
      continue;
    }

    const nci = cellIdx(nr, nc);
    const kind = board.cellKind[nci];

    // Record beam segment. If hitting blocker/emitter, terminate cleanly at its face (~0.62 of step).
    if (kind === 1 || kind === 2) {
      const hitKey = `hit:${cur.r},${cur.c}->${nr},${nc}`;
      const existing = exitMap.get(hitKey);
      if (existing) {
        existing.mask = (existing.mask | cur.bit) as ColorMask;
      } else {
        exitMap.set(hitKey, {
          r1: cur.r,
          c1: cur.c,
          r2: cur.r + delta.dr * 0.62,
          c2: cur.c + delta.dc * 0.62,
          mask: cur.bit,
        });
      }
      continue;
    }

    // Undirected canonical segment key for adjacent cell centers
    const aFirst = cur.r < nr || (cur.r === nr && cur.c < nc);
    const segKey = aFirst
      ? `${cur.r},${cur.c}-${nr},${nc}`
      : `${nr},${nc}-${cur.r},${cur.c}`;
    const existingSeg = segmentMap.get(segKey);
    if (existingSeg) {
      existingSeg.mask = (existingSeg.mask | cur.bit) as ColorMask;
    } else {
      segmentMap.set(segKey, {
        r1: aFirst ? cur.r : nr,
        c1: aFirst ? cur.c : nc,
        r2: aFirst ? nr : cur.r,
        c2: aFirst ? nc : cur.c,
        mask: cur.bit,
      });
    }

    if (kind === 3) {
      const tIdx = board.targetAtCell[nci];
      targetReceived[tIdx] |= cur.bit;
      cellLightMask[nci] |= cur.bit;
      continue;
    }

    cellLightMask[nci] |= cur.bit;
    const optic = opticsGrid[nci];
    const nextDirs: number[] =
      optic === 0
        ? [cur.dirIdx]
        : optic === 1
          ? [SLASH_DIR[cur.dirIdx]]
          : optic === 2
            ? [BACKSLASH_DIR[cur.dirIdx]]
            : cur.dirIdx === 0 || cur.dirIdx === 2
              ? [3, 1]
              : [0, 2];

    for (const nd of nextDirs) {
      const nextState = (nci << 3) | (nd << 1) | (cur.bit - 1);
      if (visited[nextState]) {
        cycleDetected = true;
      } else {
        visited[nextState] = 1;
        queue.push({ r: nr, c: nc, dirIdx: nd, bit: cur.bit });
      }
    }
  }

  const targets: TargetState[] = puzzle.targets.map((t, idx) => {
    const reqMask = wavelengthToMask(t.required);
    const recMask = targetReceived[idx] as ColorMask;
    let status: TargetState['status'];
    if (recMask === 0) {
      status = 'unlit';
    } else if (recMask === reqMask) {
      status = 'solved';
    } else if ((recMask & ~reqMask) !== 0) {
      status = 'wrong';
    } else {
      status = 'partial';
    }
    return {
      r: t.r,
      c: t.c,
      required: t.required,
      receivedMask: recMask,
      status,
    };
  });

  const solved = targets.length > 0 && targets.every((t) => t.status === 'solved');
  const internalSegments = Array.from(segmentMap.values());
  const segments = [...internalSegments, ...Array.from(exitMap.values())];

  return {
    solved,
    opticsUsed,
    beamLength: internalSegments.length,
    segments,
    targets,
    cellLightMask,
    steps,
    cycleDetected,
  };
}
