import type { PuzzleDefinition } from './types.js';

export interface ShareCardInput {
  puzzle: Pick<PuzzleDefinition, 'date' | 'puzzleNumber' | 'parOptics' | 'targets'>;
  optics: number;
  beamLength: number;
  timeSec: number;
  percentile: number;
  streak: number;
  hintsUsed?: number;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return mins > 0 ? `${mins}m ${rem.toString().padStart(2, '0')}s` : `${rem}s`;
}

export function getEfficiencyMedal(optics: number, parOptics: number): {
  label: string;
  badge: string;
} {
  if (optics <= parOptics) return { label: 'PAR OPTIMAL', badge: '★' };
  if (optics === parOptics + 1) return { label: 'CLEAN RELAY', badge: '◆' };
  return { label: 'CLEARED', badge: '●' };
}

/**
 * Generates a crisp 3-line, 100% spoiler-free Reddit comment card.
 * Never reveals any optic coordinates, orientations, or board layout.
 */
export function formatSpoilerFreeShare(input: ShareCardInput): string {
  const { puzzle, optics, beamLength, timeSec, percentile, streak, hintsUsed = 0 } = input;
  const medal = getEfficiencyMedal(optics, puzzle.parOptics);
  const waveStrip = puzzle.targets
    .map((t) => (t.required === 'A' ? '🟧' : t.required === 'C' ? '🟦' : '⬜'))
    .join('');

  const parTag = optics <= puzzle.parOptics
    ? `PAR ${puzzle.parOptics} ${medal.badge}`
    : `${optics}/${puzzle.parOptics} par`;

  const extras: string[] = [`Top ${Math.max(1, Math.min(99, Math.round(percentile)))}%`];
  if (streak >= 2) extras.push(`${streak}d streak`);
  if (hintsUsed > 0) extras.push(`${hintsUsed} hint${hintsUsed > 1 ? 's' : ''}`);

  return [
    `PRISM RELAY #${puzzle.puzzleNumber} (${puzzle.date})`,
    `${waveStrip}  ${optics} optics (${parTag}) · ${beamLength}m beam · ${formatDuration(timeSec)}`,
    `${extras.join(' · ')} — can you beat ${optics} optics?`,
  ].join('\n');
}

export function getFlairForStreak(streak: number, hitPar: boolean): string {
  if (streak >= 14) return `Prism Master · ${streak}d Streak`;
  if (streak >= 7) return `Optics Ace · ${streak}d Streak`;
  if (streak >= 3) return `Relay Runner · ${streak}d Streak`;
  return hitPar ? 'Par Solver ★' : 'Prism Relay Solver';
}
