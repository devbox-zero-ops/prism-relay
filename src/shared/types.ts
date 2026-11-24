export const GRID_SIZE = 7;

export type Dir = 'N' | 'E' | 'S' | 'W';

export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'] as const;

export const DIR_DELTA: Record<Dir, { dr: number; dc: number }> = {
  N: { dr: -1, dc: 0 },
  E: { dr: 0, dc: 1 },
  S: { dr: 1, dc: 0 },
  W: { dr: 0, dc: -1 },
};

/** Single-wavelength color bit: 1 = Amber, 2 = Cyan */
export type BeamBit = 1 | 2;

/** Merged wavelength mask: 0 = none, 1 = Amber, 2 = Cyan, 3 = White (Amber + Cyan) */
export type ColorMask = 0 | 1 | 2 | 3;

export type WavelengthCode = 'A' | 'C' | 'W';
export type EmitterColor = 'A' | 'C';

export type OpticType = 'slash' | 'backslash' | 'splitter';

export const OPTIC_TYPES: readonly OpticType[] = ['slash', 'backslash', 'splitter'] as const;

export interface EmitterCell {
  kind: 'emitter';
  r: number;
  c: number;
  dir: Dir;
  color: EmitterColor;
}

export interface TargetCell {
  kind: 'target';
  r: number;
  c: number;
  required: WavelengthCode;
}

export interface BlockerCell {
  kind: 'blocker';
  r: number;
  c: number;
}

export interface EmptyCell {
  kind: 'empty';
  r: number;
  c: number;
}

export type BoardCell = EmitterCell | TargetCell | BlockerCell | EmptyCell;

export interface Placement {
  r: number;
  c: number;
  optic: OpticType;
}

export type PuzzleMode = 'daily' | 'archive' | 'practice';

export interface PuzzleDefinition {
  id: string;
  date: string; // YYYY-MM-DD (UTC) or practice-N
  mode: PuzzleMode;
  puzzleNumber: number;
  seed: number;
  size: number;
  emitters: EmitterCell[];
  targets: TargetCell[];
  blockers: BlockerCell[];
  parOptics: number;
  parBeamLength: number;
  /** Reference minimal solution used for 1-cell non-spoilery hints and validation */
  referenceSolution: Placement[];
}

export interface BeamSegment {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  mask: ColorMask;
  isEdgeExit?: boolean;
  exitDir?: Dir;
}

export type TargetStatus = 'unlit' | 'partial' | 'solved' | 'wrong';

export interface TargetState {
  r: number;
  c: number;
  required: WavelengthCode;
  receivedMask: ColorMask;
  status: TargetStatus;
}

export interface SimulationResult {
  solved: boolean;
  opticsUsed: number;
  beamLength: number;
  segments: BeamSegment[];
  targets: TargetState[];
  /** Per-cell wavelength bitmask passing through cell center (length = GRID_SIZE * GRID_SIZE) */
  cellLightMask: Uint8Array;
  /** Total steps processed (guaranteed bounded <= 392) */
  steps: number;
  /** Whether any ray cycle was detected and safely terminated */
  cycleDetected: boolean;
}

export interface HistogramBuckets {
  parOrBetter: number; // <= Par
  parPlus1: number;    // Par + 1
  parPlus2: number;    // Par + 2
  parPlus3Plus: number; // >= Par + 3
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  optics: number;
  beamLength: number;
  timeSec: number;
  isCurrentUser?: boolean;
}

export interface PlayerRecord {
  optics: number;
  beamLength: number;
  timeSec: number;
  solvedAt: string;
  hintsUsed: number;
}

export interface DailyApiResponse {
  date: string;
  todayUtc: string;
  username: string;
  isStandalone: boolean;
  puzzle: PuzzleDefinition;
  streak: number;
  bestStreak: number;
  personalBest: PlayerRecord | null;
  totalClears: number;
  histogram: HistogramBuckets;
  leaderboard: LeaderboardEntry[];
  hasSharedToday: boolean;
  claimedFlair: string | null;
}

export interface SolveRequest {
  date: string;
  placements: Placement[];
  timeSec: number;
  hintsUsed: number;
}

export interface SolveResponse {
  accepted: boolean;
  error?: string;
  optics: number;
  beamLength: number;
  timeSec: number;
  parOptics: number;
  percentile: number;
  totalClears: number;
  rank: number;
  streak: number;
  bestStreak: number;
  isNewBest: boolean;
  histogram: HistogramBuckets;
  leaderboard: LeaderboardEntry[];
  shareText: string;
}

export interface ShareCommentRequest {
  date: string;
  optics: number;
  timeSec: number;
}

export interface ShareCommentResponse {
  ok: boolean;
  commentId?: string;
  shareText: string;
  alreadyShared?: boolean;
  error?: string;
}

export interface ClaimFlairRequest {
  date: string;
}

export interface ClaimFlairResponse {
  ok: boolean;
  flairText?: string;
  error?: string;
}

export function wavelengthToMask(code: WavelengthCode): ColorMask {
  if (code === 'A') return 1;
  if (code === 'C') return 2;
  return 3;
}

export function emitterToBit(color: EmitterColor): BeamBit {
  return color === 'A' ? 1 : 2;
}
