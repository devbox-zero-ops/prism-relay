import express from 'express';
import { context, createServer, getServerPort, reddit, redis } from '@devvit/web/server';
import { simulateBoard } from '../shared/engine.js';
import { addUtcDays, getTodayUtcDate, isValidUtcDateString } from '../shared/prng.js';
import { formatSpoilerFreeShare, getFlairForStreak } from '../shared/shareFormat.js';
import { getDailyPuzzle } from '../shared/solver.js';
import type {
  ClaimFlairResponse,
  DailyApiResponse,
  HistogramBuckets,
  LeaderboardEntry,
  Placement,
  PlayerRecord,
  PuzzleDefinition,
  ShareCommentResponse,
  SolveRequest,
  SolveResponse,
} from '../shared/types.js';

const OPTIC_SET = new Set(['slash', 'backslash', 'splitter']);

/**
 * Encodes (optics, beamLength, timeSec) into a single monotonic ascending Redis score
 * so lower optics -> shorter beam -> faster time ranks highest.
 */
export function encodeRankScore(optics: number, beamLength: number, timeSec: number): number {
  const o = Math.min(99, Math.max(0, Math.round(optics)));
  const b = Math.min(999, Math.max(0, Math.round(beamLength)));
  const t = Math.min(9999, Math.max(0, Math.round(timeSec)));
  return o * 10_000_000 + b * 10_000 + t;
}

export function decodeRankScore(score: number): {
  optics: number;
  beamLength: number;
  timeSec: number;
} {
  const s = Math.max(0, Math.round(score));
  const optics = Math.floor(s / 10_000_000);
  const rem = s % 10_000_000;
  const beamLength = Math.floor(rem / 10_000);
  const timeSec = rem % 10_000;
  return { optics, beamLength, timeSec };
}

export function histogramBucketKey(optics: number, parOptics: number): keyof HistogramBuckets {
  const diff = optics - parOptics;
  if (diff <= 0) return 'parOrBetter';
  if (diff === 1) return 'parPlus1';
  if (diff === 2) return 'parPlus2';
  return 'parPlus3Plus';
}

export function validateSolveSubmission(
  puzzle: PuzzleDefinition,
  placements: unknown,
): { ok: true; placements: Placement[]; optics: number; beamLength: number } | { ok: false; error: string } {
  if (!Array.isArray(placements) || placements.length > 49) {
    return { ok: false, error: 'Invalid placements array.' };
  }
  const clean: Placement[] = [];
  const seen = new Set<string>();
  for (const item of placements) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Malformed placement object.' };
    }
    const { r, c, optic } = item as Record<string, unknown>;
    if (
      typeof r !== 'number' ||
      typeof c !== 'number' ||
      !Number.isInteger(r) ||
      !Number.isInteger(c) ||
      r < 0 ||
      r >= puzzle.size ||
      c < 0 ||
      c >= puzzle.size ||
      typeof optic !== 'string' ||
      !OPTIC_SET.has(optic)
    ) {
      return { ok: false, error: 'Placement out of bounds or invalid optic type.' };
    }
    const key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ r, c, optic: optic as Placement['optic'] });
  }

  const sim = simulateBoard(puzzle, clean);
  if (!sim.solved) {
    return { ok: false, error: 'Submitted optical layout does not satisfy all photodiodes.' };
  }
  return { ok: true, placements: clean, optics: sim.opticsUsed, beamLength: sim.beamLength };
}

function parseHistogram(raw: Record<string, string> | undefined): HistogramBuckets {
  return {
    parOrBetter: Number(raw?.parOrBetter ?? 0) || 0,
    parPlus1: Number(raw?.parPlus1 ?? 0) || 0,
    parPlus2: Number(raw?.parPlus2 ?? 0) || 0,
    parPlus3Plus: Number(raw?.parPlus3Plus ?? 0) || 0,
  };
}

async function fetchLeaderboard(dateStr: string, currentUser: string): Promise<{
  leaderboard: LeaderboardEntry[];
  totalClears: number;
}> {
  const lbKey = `pr:lb:${dateStr}`;
  const [topRaw, total] = await Promise.all([
    redis.zRange(lbKey, 0, 9, { by: 'rank' }),
    redis.zCard(lbKey),
  ]);
  const leaderboard: LeaderboardEntry[] = topRaw.map((entry, i) => {
    const decoded = decodeRankScore(entry.score);
    return {
      rank: i + 1,
      username: entry.member,
      optics: decoded.optics,
      beamLength: decoded.beamLength,
      timeSec: decoded.timeSec,
      isCurrentUser: entry.member === currentUser,
    };
  });
  return { leaderboard, totalClears: total };
}

async function getStreakState(userId: string): Promise<{
  streak: number;
  bestStreak: number;
  lastDate: string;
}> {
  const raw = await redis.hGetAll(`pr:streak:${userId}`);
  return {
    streak: Number(raw?.streak ?? 0) || 0,
    bestStreak: Number(raw?.bestStreak ?? 0) || 0,
    lastDate: raw?.lastDate ?? '',
  };
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const createDailyPost = async () => {
    const subredditName = context.subredditName;
    if (!subredditName) throw new Error('Subreddit context unavailable');
    const today = getTodayUtcDate();
    const puzzle = getDailyPuzzle(today, 'daily');
    return reddit.submitCustomPost({
      subredditName,
      title: `Prism Relay #${puzzle.puzzleNumber} — Daily Optical Puzzle (${today})`,
    });
  };

  app.post('/internal/on-app-install', async (_req, res) => {
    try {
      const post = await createDailyPost();
      res.json({ status: 'ok', postId: post.id });
    } catch (err) {
      res.status(500).json({ status: 'error', message: String(err) });
    }
  });

  app.post('/internal/menu/post-create', async (_req, res) => {
    try {
      const post = await createDailyPost();
      res.json({
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      });
    } catch (err) {
      res.status(500).json({ showToast: `Failed to create post: ${String(err)}` });
    }
  });

  app.get('/api/daily', async (req, res) => {
    try {
      const todayUtc = getTodayUtcDate();
      const requested = typeof req.query.date === 'string' ? req.query.date : todayUtc;
      const modeParam = typeof req.query.mode === 'string' ? req.query.mode : 'daily';

      let dateKey = todayUtc;
      let mode: 'daily' | 'archive' | 'practice' = 'daily';
      if (modeParam === 'practice' && /^practice-[a-z0-9-]+$/i.test(requested)) {
        dateKey = requested;
        mode = 'practice';
      } else if (isValidUtcDateString(requested)) {
        dateKey = requested;
        mode = requested === todayUtc ? 'daily' : 'archive';
      }

      const puzzle = getDailyPuzzle(dateKey, mode);
      const username = (await reddit.getCurrentUsername()) || 'guest';
      const userKey = context.userId || username;

      const [histRaw, lbData, streakState, recJson, sharedFlag, flairFlag] = await Promise.all([
        redis.hGetAll(`pr:hist:${dateKey}`),
        fetchLeaderboard(dateKey, username),
        getStreakState(userKey),
        redis.get(`pr:rec:${dateKey}:${userKey}`),
        redis.get(`pr:shared:${dateKey}:${userKey}`),
        redis.get(`pr:flair:${userKey}`),
      ]);

      const personalBest: PlayerRecord | null = recJson ? (JSON.parse(recJson) as PlayerRecord) : null;

      const payload: DailyApiResponse = {
        date: dateKey,
        todayUtc,
        username,
        isStandalone: false,
        puzzle,
        streak: streakState.streak,
        bestStreak: streakState.bestStreak,
        personalBest,
        totalClears: lbData.totalClears,
        histogram: parseHistogram(histRaw),
        leaderboard: lbData.leaderboard,
        hasSharedToday: Boolean(sharedFlag),
        claimedFlair: flairFlag || null,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: `Failed to load puzzle: ${String(err)}` });
    }
  });

  app.post('/api/solve', async (req, res) => {
    try {
      const body = req.body as Partial<SolveRequest>;
      const todayUtc = getTodayUtcDate();
      const dateKey = typeof body.date === 'string' ? body.date : todayUtc;
      const isPractice = dateKey.startsWith('practice-');
      if (!isPractice && !isValidUtcDateString(dateKey)) {
        res.status(400).json({ accepted: false, error: 'Invalid date key.' });
        return;
      }

      const mode = isPractice ? 'practice' : dateKey === todayUtc ? 'daily' : 'archive';
      const puzzle = getDailyPuzzle(dateKey, mode);
      const check = validateSolveSubmission(puzzle, body.placements);
      if (!check.ok) {
        res.status(400).json({ accepted: false, error: check.error });
        return;
      }

      const timeSec = Math.max(1, Math.min(3600, Math.round(Number(body.timeSec) || 1)));
      const hintsUsed = Math.max(0, Math.min(10, Math.round(Number(body.hintsUsed) || 0)));
      const username = (await reddit.getCurrentUsername()) || 'guest';
      const userKey = context.userId || username;

      const recKey = `pr:rec:${dateKey}:${userKey}`;
      const lbKey = `pr:lb:${dateKey}`;
      const histKey = `pr:hist:${dateKey}`;

      const prevJson = await redis.get(recKey);
      const prevRec: PlayerRecord | null = prevJson ? (JSON.parse(prevJson) as PlayerRecord) : null;
      const newScore = encodeRankScore(check.optics, check.beamLength, timeSec);
      const prevScore = prevRec
        ? encodeRankScore(prevRec.optics, prevRec.beamLength, prevRec.timeSec)
        : Number.POSITIVE_INFINITY;

      const isNewBest = newScore < prevScore;
      const isFirstClear = prevRec === null;

      if (isNewBest) {
        const record: PlayerRecord = {
          optics: check.optics,
          beamLength: check.beamLength,
          timeSec,
          solvedAt: new Date().toISOString(),
          hintsUsed,
        };
        await redis.set(recKey, JSON.stringify(record));
        await redis.zAdd(lbKey, { member: username, score: newScore });
      }

      if (isFirstClear) {
        await redis.hIncrBy(histKey, histogramBucketKey(check.optics, puzzle.parOptics), 1);
      }

      // Update consecutive UTC daily streak only on today's official daily puzzle
      let streakState = await getStreakState(userKey);
      if (dateKey === todayUtc && streakState.lastDate !== todayUtc) {
        const yesterday = addUtcDays(todayUtc, -1);
        const nextStreak = streakState.lastDate === yesterday ? streakState.streak + 1 : 1;
        const nextBest = Math.max(streakState.bestStreak, nextStreak);
        await redis.hSet(`pr:streak:${userKey}`, {
          streak: String(nextStreak),
          bestStreak: String(nextBest),
          lastDate: todayUtc,
        });
        streakState = { streak: nextStreak, bestStreak: nextBest, lastDate: todayUtc };
      }

      const [histRaw, lbData, rankZero] = await Promise.all([
        redis.hGetAll(histKey),
        fetchLeaderboard(dateKey, username),
        redis.zRank(lbKey, username),
      ]);

      const rank = typeof rankZero === 'number' ? rankZero + 1 : lbData.totalClears || 1;
      const total = Math.max(1, lbData.totalClears);
      const percentile = Math.max(1, Math.min(99, Math.ceil((rank / total) * 100)));

      const shareText = formatSpoilerFreeShare({
        puzzle,
        optics: check.optics,
        beamLength: check.beamLength,
        timeSec,
        percentile,
        streak: streakState.streak,
        hintsUsed,
      });

      const response: SolveResponse = {
        accepted: true,
        optics: check.optics,
        beamLength: check.beamLength,
        timeSec,
        parOptics: puzzle.parOptics,
        percentile,
        totalClears: total,
        rank,
        streak: streakState.streak,
        bestStreak: streakState.bestStreak,
        isNewBest,
        histogram: parseHistogram(histRaw),
        leaderboard: lbData.leaderboard,
        shareText,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ accepted: false, error: `Solve error: ${String(err)}` });
    }
  });

  app.post('/api/share-comment', async (req, res) => {
    try {
      const todayUtc = getTodayUtcDate();
      const dateKey = typeof req.body?.date === 'string' && isValidUtcDateString(req.body.date)
        ? req.body.date
        : todayUtc;
      const username = (await reddit.getCurrentUsername()) || 'guest';
      const userKey = context.userId || username;

      const recJson = await redis.get(`pr:rec:${dateKey}:${userKey}`);
      if (!recJson) {
        res.status(400).json({ ok: false, shareText: '', error: 'Solve the puzzle first.' });
        return;
      }
      const rec = JSON.parse(recJson) as PlayerRecord;
      const puzzle = getDailyPuzzle(dateKey, dateKey === todayUtc ? 'daily' : 'archive');
      const [streakState, totalClears, rankZero] = await Promise.all([
        getStreakState(userKey),
        redis.zCard(`pr:lb:${dateKey}`),
        redis.zRank(`pr:lb:${dateKey}`, username),
      ]);
      const rank = typeof rankZero === 'number' ? rankZero + 1 : 1;
      const percentile = Math.max(1, Math.min(99, Math.ceil((rank / Math.max(1, totalClears)) * 100)));
      const shareText = formatSpoilerFreeShare({
        puzzle,
        optics: rec.optics,
        beamLength: rec.beamLength,
        timeSec: rec.timeSec,
        percentile,
        streak: streakState.streak,
        hintsUsed: rec.hintsUsed,
      });

      const sharedKey = `pr:shared:${dateKey}:${userKey}`;
      const existing = await redis.get(sharedKey);
      if (existing) {
        const out: ShareCommentResponse = {
          ok: true,
          alreadyShared: true,
          commentId: existing,
          shareText,
        };
        res.json(out);
        return;
      }

      const postId = context.postId;
      if (!postId) {
        res.status(400).json({ ok: false, shareText, error: 'Post context missing.' });
        return;
      }

      const comment = await reddit.submitComment({
        id: postId as `t3_${string}`,
        text: shareText,
      });
      await redis.set(sharedKey, comment.id);
      const out: ShareCommentResponse = { ok: true, commentId: comment.id, shareText };
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, shareText: '', error: String(err) });
    }
  });

  app.post('/api/claim-flair', async (req, res) => {
    try {
      const todayUtc = getTodayUtcDate();
      const dateKey = typeof req.body?.date === 'string' && isValidUtcDateString(req.body.date)
        ? req.body.date
        : todayUtc;
      const username = await reddit.getCurrentUsername();
      const subredditName = context.subredditName;
      if (!username || !subredditName) {
        res.status(400).json({ ok: false, error: 'Sign in on Reddit to claim user flair.' });
        return;
      }
      const userKey = context.userId || username;
      const [recJson, streakState] = await Promise.all([
        redis.get(`pr:rec:${dateKey}:${userKey}`),
        getStreakState(userKey),
      ]);
      if (!recJson) {
        res.status(400).json({ ok: false, error: 'Complete a puzzle before claiming flair.' });
        return;
      }
      const rec = JSON.parse(recJson) as PlayerRecord;
      const puzzle = getDailyPuzzle(dateKey, dateKey === todayUtc ? 'daily' : 'archive');
      const flairText = getFlairForStreak(streakState.streak, rec.optics <= puzzle.parOptics);
      await reddit.setUserFlair({
        subredditName,
        username,
        text: flairText,
      });
      await redis.set(`pr:flair:${userKey}`, flairText);
      const out: ClaimFlairResponse = { ok: true, flairText };
      res.json(out);
    } catch (err) {
      res.status(200).json({
        ok: false,
        error: `Subreddit user flair unavailable (${String(err).slice(0, 80)})`,
      });
    }
  });

  return app;
}

// Start Devvit server when executed directly in the Devvit runtime
if (typeof process !== 'undefined' && process.env.VITEST !== 'true') {
  const app = createApp();
  const server = createServer(app);
  server.on('error', (err) => console.error(`Prism Relay server error: ${err.stack}`));
  server.listen(getServerPort());
}
