import { simulateBoard } from '../shared/engine.js';
import { addUtcDays, getTodayUtcDate, hashStringToSeed } from '../shared/prng.js';
import { formatSpoilerFreeShare, getFlairForStreak } from '../shared/shareFormat.js';
import { getDailyPuzzle } from '../shared/solver.js';
import type {
  ClaimFlairResponse,
  DailyApiResponse,
  HistogramBuckets,
  LeaderboardEntry,
  Placement,
  PlayerRecord,
  PuzzleMode,
  ShareCommentResponse,
  SolveResponse,
} from '../shared/types.js';

const STORAGE_PREFIX = 'prism_relay_local_v1:';

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors in sandboxed iframes
  }
}

/** Deterministic community baseline for standalone local preview outside Reddit. */
function buildLocalCommunity(dateKey: string, parOptics: number, myRecord: PlayerRecord | null): {
  histogram: HistogramBuckets;
  leaderboard: LeaderboardEntry[];
  totalClears: number;
} {
  const h = hashStringToSeed(`community:${dateKey}`);
  const histogram: HistogramBuckets = {
    parOrBetter: 24 + (h % 19),
    parPlus1: 38 + ((h >>> 4) % 24),
    parPlus2: 19 + ((h >>> 8) % 14),
    parPlus3Plus: 9 + ((h >>> 12) % 9),
  };

  if (myRecord) {
    const diff = myRecord.optics - parOptics;
    if (diff <= 0) histogram.parOrBetter += 1;
    else if (diff === 1) histogram.parPlus1 += 1;
    else if (diff === 2) histogram.parPlus2 += 1;
    else histogram.parPlus3Plus += 1;
  }

  const totalClears =
    histogram.parOrBetter + histogram.parPlus1 + histogram.parPlus2 + histogram.parPlus3Plus;

  const basePeers = [
    { username: 'optics_mira', optics: parOptics, beamLength: 13, timeSec: 27 },
    { username: 'laser_kaito', optics: parOptics, beamLength: 14, timeSec: 34 },
    { username: 'prism_daria', optics: parOptics + 1, beamLength: 15, timeSec: 41 },
    { username: 'photon_lee', optics: parOptics + 1, beamLength: 16, timeSec: 49 },
    { username: 'beam_nora', optics: parOptics + 2, beamLength: 18, timeSec: 63 },
  ];

  const rows: Array<{
    username: string;
    optics: number;
    beamLength: number;
    timeSec: number;
    isCurrentUser?: boolean;
  }> = [...basePeers];

  if (myRecord) {
    rows.push({
      username: 'you',
      optics: myRecord.optics,
      beamLength: myRecord.beamLength,
      timeSec: myRecord.timeSec,
      isCurrentUser: true,
    });
  }

  rows.sort((a, b) => a.optics - b.optics || a.beamLength - b.beamLength || a.timeSec - b.timeSec);
  const leaderboard: LeaderboardEntry[] = rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    ...r,
  }));

  return { histogram, leaderboard, totalClears };
}

function shouldPreferStandalone(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get('standalone') === '1') return true;
  const host = window.location.hostname;
  return host.endsWith('github.io');
}

export async function fetchDailyState(
  dateKey: string,
  mode: PuzzleMode,
): Promise<DailyApiResponse> {
  if (!shouldPreferStandalone()) {
    try {
      const resp = await fetch(
        `/api/daily?date=${encodeURIComponent(dateKey)}&mode=${encodeURIComponent(mode)}`,
        { headers: { Accept: 'application/json' } },
      );
      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.includes('application/json')) {
        return (await resp.json()) as DailyApiResponse;
      }
    } catch {
      // Fall back to deterministic standalone client engine outside Devvit server
    }
  }

  const todayUtc = getTodayUtcDate();
  const puzzle = getDailyPuzzle(dateKey, mode);
  const streakObj = readLocal<{ streak: number; bestStreak: number; lastDate: string }>('streak', {
    streak: 0,
    bestStreak: 0,
    lastDate: '',
  });
  const personalBest = readLocal<PlayerRecord | null>(`rec:${dateKey}`, null);
  const community = buildLocalCommunity(dateKey, puzzle.parOptics, personalBest);

  return {
    date: dateKey,
    todayUtc,
    username: 'you',
    isStandalone: true,
    puzzle,
    streak: streakObj.streak,
    bestStreak: streakObj.bestStreak,
    personalBest,
    totalClears: community.totalClears,
    histogram: community.histogram,
    leaderboard: community.leaderboard,
    hasSharedToday: readLocal<boolean>(`shared:${dateKey}`, false),
    claimedFlair: readLocal<string | null>('flair', null),
  };
}

export async function submitSolve(
  dateKey: string,
  mode: PuzzleMode,
  placements: Placement[],
  timeSec: number,
  hintsUsed: number,
  isStandalone: boolean,
): Promise<SolveResponse> {
  if (!isStandalone) {
    try {
      const resp = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateKey, placements, timeSec, hintsUsed }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (resp.ok && ct.includes('application/json')) {
        return (await resp.json()) as SolveResponse;
      }
    } catch {
      // Fall through to local validator
    }
  }

  const todayUtc = getTodayUtcDate();
  const puzzle = getDailyPuzzle(dateKey, mode);
  const sim = simulateBoard(puzzle, placements);
  if (!sim.solved) {
    return {
      accepted: false,
      error: 'Board is not solved.',
      optics: sim.opticsUsed,
      beamLength: sim.beamLength,
      timeSec,
      parOptics: puzzle.parOptics,
      percentile: 99,
      totalClears: 1,
      rank: 1,
      streak: 0,
      bestStreak: 0,
      isNewBest: false,
      histogram: { parOrBetter: 0, parPlus1: 0, parPlus2: 0, parPlus3Plus: 0 },
      leaderboard: [],
      shareText: '',
    };
  }

  const prev = readLocal<PlayerRecord | null>(`rec:${dateKey}`, null);
  const isNewBest =
    !prev ||
    sim.opticsUsed < prev.optics ||
    (sim.opticsUsed === prev.optics && sim.beamLength < prev.beamLength) ||
    (sim.opticsUsed === prev.optics && sim.beamLength === prev.beamLength && timeSec < prev.timeSec);

  const rec: PlayerRecord = isNewBest
    ? {
        optics: sim.opticsUsed,
        beamLength: sim.beamLength,
        timeSec,
        solvedAt: new Date().toISOString(),
        hintsUsed,
      }
    : (prev as PlayerRecord);
  writeLocal(`rec:${dateKey}`, rec);

  const streakObj = readLocal<{ streak: number; bestStreak: number; lastDate: string }>('streak', {
    streak: 0,
    bestStreak: 0,
    lastDate: '',
  });
  if (dateKey === todayUtc && streakObj.lastDate !== todayUtc) {
    const yest = addUtcDays(todayUtc, -1);
    streakObj.streak = streakObj.lastDate === yest ? streakObj.streak + 1 : 1;
    streakObj.bestStreak = Math.max(streakObj.bestStreak, streakObj.streak);
    streakObj.lastDate = todayUtc;
    writeLocal('streak', streakObj);
  }

  const community = buildLocalCommunity(dateKey, puzzle.parOptics, rec);
  const myEntry = community.leaderboard.find((e) => e.isCurrentUser);
  const rank = myEntry ? myEntry.rank : Math.max(1, Math.round(community.totalClears * 0.45));
  const percentile =
    sim.opticsUsed <= puzzle.parOptics
      ? Math.max(2, Math.min(18, Math.round((rank / community.totalClears) * 100) + 4))
      : Math.max(15, Math.min(92, Math.round((rank / community.totalClears) * 100) + 22));

  const shareText = formatSpoilerFreeShare({
    puzzle,
    optics: sim.opticsUsed,
    beamLength: sim.beamLength,
    timeSec,
    percentile,
    streak: streakObj.streak,
    hintsUsed,
  });

  return {
    accepted: true,
    optics: sim.opticsUsed,
    beamLength: sim.beamLength,
    timeSec,
    parOptics: puzzle.parOptics,
    percentile,
    totalClears: community.totalClears,
    rank,
    streak: streakObj.streak,
    bestStreak: streakObj.bestStreak,
    isNewBest,
    histogram: community.histogram,
    leaderboard: community.leaderboard,
    shareText,
  };
}

export async function postShareComment(
  dateKey: string,
  shareText: string,
  isStandalone: boolean,
): Promise<ShareCommentResponse> {
  if (!isStandalone) {
    try {
      const resp = await fetch('/api/share-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateKey }),
      });
      if (resp.ok) {
        return (await resp.json()) as ShareCommentResponse;
      }
    } catch {
      // fallback below
    }
  }
  writeLocal(`shared:${dateKey}`, true);
  return { ok: true, shareText, commentId: 'preview-local' };
}

export async function claimUserFlair(
  dateKey: string,
  streak: number,
  hitPar: boolean,
  isStandalone: boolean,
): Promise<ClaimFlairResponse> {
  if (!isStandalone) {
    try {
      const resp = await fetch('/api/claim-flair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateKey }),
      });
      if (resp.ok) {
        return (await resp.json()) as ClaimFlairResponse;
      }
    } catch {
      // fallback below
    }
  }
  const flairText = getFlairForStreak(streak, hitPar);
  writeLocal('flair', flairText);
  return { ok: true, flairText };
}
