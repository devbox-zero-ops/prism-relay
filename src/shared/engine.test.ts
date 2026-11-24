import { describe, expect, it } from 'vitest';
import { simulateBoard } from './engine.js';
import { addUtcDays } from './prng.js';
import { formatSpoilerFreeShare } from './shareFormat.js';
import { findMinimumOpticsSolution, getDailyPuzzle } from './solver.js';
import { decodeRankScore, encodeRankScore, validateSolveSubmission } from '../server/index.js';

describe('Prism Relay — Optical Engine, Exact Solver & Anti-Cheat', () => {
  it('generates 30 consecutive UTC daily puzzles that are 100% solvable with Par >= 3 and merged White target', () => {
    const startDate = '2026-11-25';
    for (let i = 0; i < 30; i++) {
      const dateStr = addUtcDays(startDate, i);
      const puzzle = getDailyPuzzle(dateStr, 'daily');

      expect(puzzle.parOptics).toBeGreaterThanOrEqual(3);
      expect(puzzle.referenceSolution.length).toBe(puzzle.parOptics);
      expect(puzzle.targets.some((t) => t.required === 'W')).toBe(true);
      expect(puzzle.targets.some((t) => t.required === 'A')).toBe(true);
      expect(puzzle.targets.some((t) => t.required === 'C')).toBe(true);

      // Empty board must not be trivially solved
      const emptySim = simulateBoard(puzzle, []);
      expect(emptySim.solved).toBe(false);

      // Reference solution must solve cleanly
      const solvedSim = simulateBoard(puzzle, puzzle.referenceSolution);
      expect(solvedSim.solved).toBe(true);
      expect(solvedSim.opticsUsed).toBe(puzzle.parOptics);

      // Exact solver confirms no shortcut strictly below Par exists
      const shortcut = findMinimumOpticsSolution(puzzle, puzzle.parOptics - 1, 14000);
      expect(shortcut.solvable).toBe(false);
    }
  });

  it('safely terminates a splitter-fed optical loop without hanging', () => {
    const loopPuzzle = {
      emitters: [{ kind: 'emitter' as const, r: 1, c: 0, dir: 'E' as const, color: 'A' as const }],
      targets: [{ kind: 'target' as const, r: 6, c: 6, required: 'A' as const }],
      blockers: [],
    };
    // E into (1,2) '+' splits N & S -> S hits (4,2) '\' (turns E) -> (4,4) '/' (turns N) -> (1,4) '\' (turns W) -> re-enters (1,2) '+'!
    const loopPlacements = [
      { r: 1, c: 2, optic: 'splitter' as const },
      { r: 4, c: 2, optic: 'backslash' as const },
      { r: 4, c: 4, optic: 'slash' as const },
      { r: 1, c: 4, optic: 'backslash' as const },
    ];
    const sim = simulateBoard(loopPuzzle, loopPlacements);
    expect(sim.cycleDetected).toBe(true);
    expect(sim.steps).toBeLessThanOrEqual(392);
    expect(sim.solved).toBe(false);
  });

  it('validates real solutions and rejects bogus or partial submissions server-side', () => {
    const puzzle = getDailyPuzzle('2026-11-25', 'daily');
    const valid = validateSolveSubmission(puzzle, puzzle.referenceSolution);
    expect(valid.ok).toBe(true);

    const partial = validateSolveSubmission(puzzle, puzzle.referenceSolution.slice(0, 1));
    expect(partial.ok).toBe(false);

    const outOfBounds = validateSolveSubmission(puzzle, [{ r: 99, c: 0, optic: 'slash' }]);
    expect(outOfBounds.ok).toBe(false);
  });

  it('preserves strict monotonic leaderboard ranking and generates spoiler-free share cards', () => {
    const better = encodeRankScore(3, 14, 42);
    const worseOptics = encodeRankScore(4, 10, 12);
    const worseTime = encodeRankScore(3, 14, 55);
    expect(better).toBeLessThan(worseTime);
    expect(worseTime).toBeLessThan(worseOptics);
    expect(decodeRankScore(better)).toEqual({ optics: 3, beamLength: 14, timeSec: 42 });

    const puzzle = getDailyPuzzle('2026-11-25', 'daily');
    const card = formatSpoilerFreeShare({
      puzzle,
      optics: puzzle.parOptics,
      beamLength: puzzle.parBeamLength,
      timeSec: 38,
      percentile: 7,
      streak: 4,
    });
    expect(card).toContain(`PRISM RELAY #${puzzle.puzzleNumber}`);
    expect(card).toContain('PAR');
    expect(card).not.toContain('slash');
    expect(card).not.toContain('backslash');
    expect(card).not.toContain('splitter');
  });
});
