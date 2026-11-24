import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { simulateBoard } from '../shared/engine.js';
import { getArchiveDates, getTodayUtcDate } from '../shared/prng.js';
import { formatDuration, formatSpoilerFreeShare, getEfficiencyMedal } from '../shared/shareFormat.js';
import {
  type ColorMask,
  type DailyApiResponse,
  GRID_SIZE,
  type OpticType,
  type Placement,
  type PuzzleDefinition,
  type PuzzleMode,
  type SimulationResult,
  type SolveResponse,
} from '../shared/types.js';
import { claimUserFlair, fetchDailyState, postShareComment, submitSolve } from './api.js';
import { soundEngine } from './audio.js';

type ToolSelection = 'cycle' | OpticType | 'erase';

const OPTIC_CYCLE: Array<OpticType | null> = ['slash', 'backslash', 'splitter', null];

function beamStrokeColor(mask: ColorMask): { core: string; glow: string } {
  if (mask === 3) return { core: '#f8fafc', glow: 'rgba(248, 250, 252, 0.72)' };
  if (mask === 2) return { core: '#22d3ee', glow: 'rgba(34, 211, 238, 0.65)' };
  return { core: '#f59e0b', glow: 'rgba(245, 158, 11, 0.65)' };
}

function targetColorHex(code: 'A' | 'C' | 'W'): string {
  if (code === 'A') return '#f59e0b';
  if (code === 'C') return '#22d3ee';
  return '#f8fafc';
}

/**
 * Mandatory Safari fallback for <dialog closedby="any"> when closedBy is unsupported.
 */
function attachLightDismissFallback(dialog: HTMLDialogElement | null): () => void {
  if (!dialog) return () => {};
  if ('closedBy' in HTMLDialogElement.prototype) return () => {};
  const handler = (event: MouseEvent) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!inside) {
      dialog.close();
    }
  };
  dialog.addEventListener('click', handler);
  return () => dialog.removeEventListener('click', handler);
}

function drawOpticalBench(
  canvas: HTMLCanvasElement,
  puzzle: PuzzleDefinition,
  placements: Map<string, OpticType>,
  sim: SimulationResult,
  cursor: { r: number; c: number },
  hintCellKey: string | null,
  phase: number,
  glowEnabled: boolean,
): void {
  const rect = canvas.getBoundingClientRect();
  const cssSize = Math.max(240, Math.round(rect.width || 360));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelSize = Math.round(cssSize * dpr);
  if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
    canvas.width = pixelSize;
    canvas.height = pixelSize;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.scale(dpr, dpr);

  const pad = 8;
  const boardPx = cssSize - pad * 2;
  const cell = boardPx / GRID_SIZE;
  const cx = (col: number) => pad + (col + 0.5) * cell;
  const cy = (row: number) => pad + (row + 0.5) * cell;

  // Obsidian optical bench plate
  const bgGrad = ctx.createLinearGradient(0, 0, cssSize, cssSize);
  bgGrad.addColorStop(0, '#0d1420');
  bgGrad.addColorStop(1, '#080c14');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, cssSize, cssSize);

  // Subtle recessed grid cells
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const x = pad + c * cell + 2;
      const y = pad + r * cell + 2;
      const w = cell - 4;
      const key = `${r},${c}`;
      ctx.fillStyle = '#111a2a';
      ctx.beginPath();
      ctx.roundRect(x, y, w, w, 6);
      ctx.fill();

      ctx.strokeStyle = key === hintCellKey ? '#34d399' : '#1e2c44';
      ctx.lineWidth = key === hintCellKey ? 2 : 1;
      ctx.stroke();

      // Precision mounting peg dot in center of open cells
      ctx.fillStyle = '#243550';
      ctx.beginPath();
      ctx.arc(cx(c), cy(r), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw merged glowing beams underneath optics/housing
  const pulseAlpha = glowEnabled ? 0.85 + 0.15 * Math.sin(phase * 2.2) : 0.92;
  for (const seg of sim.segments) {
    const x1 = cx(seg.c1);
    const y1 = cy(seg.r1);
    const x2 = cx(seg.c2);
    const y2 = cy(seg.r2);
    const palette = beamStrokeColor(seg.mask);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha = pulseAlpha;
    if (glowEnabled) {
      ctx.strokeStyle = palette.glow;
      ctx.lineWidth = Math.max(7, cell * 0.19);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.strokeStyle = palette.core;
    ctx.lineWidth = Math.max(2.6, cell * 0.075);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Draw obsidian blockers
  for (const b of puzzle.blockers) {
    const x = pad + b.c * cell + 5;
    const y = pad + b.r * cell + 5;
    const w = cell - 10;
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, w, 6);
    ctx.fill();
    ctx.stroke();

    // Machined diagonal hash mark
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x + 7, y + w - 7);
    ctx.lineTo(x + w - 7, y + 7);
    ctx.stroke();
  }

  // Draw laser emitters
  for (const e of puzzle.emitters) {
    const x = cx(e.c);
    const y = cy(e.r);
    const col = e.color === 'A' ? '#f59e0b' : '#22d3ee';
    const rad = cell * 0.34;

    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.roundRect(x - rad, y - rad, rad * 2, rad * 2, 8);
    ctx.fill();
    ctx.stroke();

    // Directional nozzle triangle
    const angle = e.dir === 'E' ? 0 : e.dir === 'S' ? Math.PI / 2 : e.dir === 'W' ? Math.PI : -Math.PI / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(rad * 0.72, 0);
    ctx.lineTo(-rad * 0.35, -rad * 0.48);
    ctx.lineTo(-rad * 0.35, rad * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Draw photodiode targets
  for (const t of sim.targets) {
    const x = cx(t.c);
    const y = cy(t.r);
    const rad = cell * 0.33;
    const reqHex = targetColorHex(t.required);

    // Outer status halo
    if (t.status === 'solved') {
      ctx.fillStyle = 'rgba(52, 211, 153, 0.24)';
      ctx.beginPath();
      ctx.arc(x, y, rad * 1.24, 0, Math.PI * 2);
      ctx.fill();
    } else if (t.status === 'wrong') {
      ctx.fillStyle = 'rgba(251, 113, 133, 0.28)';
      ctx.beginPath();
      ctx.arc(x, y, rad * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = t.status === 'solved' ? reqHex : '#0c1322';
    ctx.strokeStyle =
      t.status === 'solved' ? '#34d399' : t.status === 'wrong' ? '#fb7185' : reqHex;
    ctx.lineWidth = t.status === 'solved' ? 3 : 2.2;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // For White target receiving partial wavelength, show half-ring charge indicator
    if (t.required === 'W' && t.status === 'partial') {
      ctx.strokeStyle = t.receivedMask === 1 ? '#f59e0b' : '#22d3ee';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, rad * 0.65, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
    }

    // Center crystal glyph (A / C / W or checkmark when locked)
    ctx.fillStyle = t.status === 'solved' ? '#090d14' : reqHex;
    ctx.font = `800 ${Math.round(cell * 0.28)}px Inter, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyph = t.status === 'solved' ? '✓' : t.required === 'W' ? 'A+C' : t.required;
    ctx.fillText(glyph, x, y + 0.5);
  }

  // Draw player-placed optics
  placements.forEach((optic, key) => {
    const [rStr, cStr] = key.split(',');
    const r = Number(rStr);
    const c = Number(cStr);
    const x = cx(c);
    const y = cy(r);
    const span = cell * 0.34;

    ctx.save();
    ctx.lineCap = 'round';
    if (optic === 'slash') {
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.32)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x - span, y + span);
      ctx.lineTo(x + span, y - span);
      ctx.stroke();

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(x - span, y + span);
      ctx.lineTo(x + span, y - span);
      ctx.stroke();
    } else if (optic === 'backslash') {
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.32)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x - span, y - span);
      ctx.lineTo(x + span, y + span);
      ctx.stroke();

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(x - span, y - span);
      ctx.lineTo(x + span, y + span);
      ctx.stroke();
    } else {
      // Beam splitter '+' diamond prism
      ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y - span * 0.95);
      ctx.lineTo(x + span * 0.95, y);
      ctx.lineTo(x, y + span * 0.95);
      ctx.lineTo(x - span * 0.95, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - span * 0.55, y);
      ctx.lineTo(x + span * 0.55, y);
      ctx.moveTo(x, y - span * 0.55);
      ctx.lineTo(x, y + span * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  });

  // Keyboard / focus cursor reticle
  const fx = pad + cursor.c * cell + 3;
  const fy = pad + cursor.r * cell + 3;
  const fw = cell - 6;
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.roundRect(fx, fy, fw, fw, 6);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

export function App(): React.ReactElement {
  const [todayUtc] = useState(() => getTodayUtcDate());
  const [dateKey, setDateKey] = useState<string>(() => getTodayUtcDate());
  const [mode, setMode] = useState<PuzzleMode>('daily');
  const [practiceCounter, setPracticeCounter] = useState<number>(1);
  const [apiState, setApiState] = useState<DailyApiResponse | null>(null);
  const [placements, setPlacements] = useState<Map<string, OpticType>>(() => new Map());
  const [history, setHistory] = useState<Array<Map<string, OpticType>>>([]);
  const [tool, setTool] = useState<ToolSelection>('cycle');
  const [cursor, setCursor] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [hintsUsed, setHintsUsed] = useState<number>(0);
  const [hintCellKey, setHintCellKey] = useState<string | null>(null);
  const [solveResult, setSolveResult] = useState<SolveResponse | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('Tap any grid cell to place or rotate optics.');
  const [muted, setMuted] = useState<boolean>(false);
  const [glowEnabled, setGlowEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  const [shareBusy, setShareBusy] = useState<boolean>(false);
  const [flairBusy, setFlairBusy] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statsDialogRef = useRef<HTMLDialogElement | null>(null);
  const archiveDialogRef = useRef<HTMLDialogElement | null>(null);
  const rulesDialogRef = useRef<HTMLDialogElement | null>(null);
  const prevSolvedCountRef = useRef<number>(0);
  const submittedSolveSigRef = useRef<string>('');
  const phaseRef = useRef<number>(0);

  // Respect explicit ?theme=light|dark and parent postMessage theme updates (Safari iframe-safe)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
    const onMsg = (ev: MessageEvent) => {
      if (ev.data && typeof ev.data === 'object' && ev.data.type === 'theme') {
        if (ev.data.theme === 'dark' || ev.data.theme === 'light') {
          document.documentElement.setAttribute('data-theme', ev.data.theme);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Attach Safari light-dismiss fallbacks for all three native <dialog> elements
  useEffect(() => {
    const c1 = attachLightDismissFallback(statsDialogRef.current);
    const c2 = attachLightDismissFallback(archiveDialogRef.current);
    const c3 = attachLightDismissFallback(rulesDialogRef.current);
    return () => {
      c1();
      c2();
      c3();
    };
  }, []);

  // Load puzzle state whenever dateKey or mode changes
  useEffect(() => {
    let active = true;
    setPlacements(new Map());
    setHistory([]);
    setElapsedSec(0);
    setHintsUsed(0);
    setHintCellKey(null);
    setSolveResult(null);
    submittedSolveSigRef.current = '';
    prevSolvedCountRef.current = 0;

    void fetchDailyState(dateKey, mode).then((data) => {
      if (!active) return;
      setApiState(data);
      setStatusMsg(
        `Route Amber + Cyan beams into all ${data.puzzle.targets.length} photodiodes. Par: ${data.puzzle.parOptics} optics.`,
      );
    });

    return () => {
      active = false;
    };
  }, [dateKey, mode]);

  const puzzle = apiState?.puzzle ?? null;

  const fixedCellSet = useMemo(() => {
    const set = new Set<string>();
    if (!puzzle) return set;
    puzzle.emitters.forEach((e) => set.add(`${e.r},${e.c}`));
    puzzle.targets.forEach((t) => set.add(`${t.r},${t.c}`));
    puzzle.blockers.forEach((b) => set.add(`${b.r},${b.c}`));
    return set;
  }, [puzzle]);

  const placementList: Placement[] = useMemo(() => {
    const list: Placement[] = [];
    placements.forEach((optic, key) => {
      const [r, c] = key.split(',').map(Number);
      list.push({ r, c, optic });
    });
    return list;
  }, [placements]);

  const sim: SimulationResult | null = useMemo(() => {
    if (!puzzle) return null;
    return simulateBoard(puzzle, placementList);
  }, [puzzle, placementList]);

  // Run elapsed timer while unsolved
  useEffect(() => {
    if (!puzzle || sim?.solved) return;
    const id = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [puzzle, sim?.solved]);

  // Trigger audio chimes and server-validated solve submission
  useEffect(() => {
    if (!puzzle || !sim || !apiState) return;
    const solvedCount = sim.targets.filter((t) => t.status === 'solved').length;
    if (solvedCount > prevSolvedCountRef.current && !sim.solved) {
      soundEngine.targetLock(solvedCount);
    }
    prevSolvedCountRef.current = solvedCount;

    if (sim.solved) {
      const sig = `${puzzle.id}:${sim.opticsUsed}:${sim.beamLength}`;
      if (submittedSolveSigRef.current !== sig) {
        submittedSolveSigRef.current = sig;
        soundEngine.victoryChord();
        void submitSolve(
          apiState.date,
          mode,
          placementList,
          Math.max(1, elapsedSec),
          hintsUsed,
          apiState.isStandalone,
        ).then((res) => {
          if (res.accepted) {
            setSolveResult(res);
            setApiState((prev) =>
              prev
                ? {
                    ...prev,
                    streak: res.streak,
                    bestStreak: res.bestStreak,
                    totalClears: res.totalClears,
                    histogram: res.histogram,
                    leaderboard: res.leaderboard,
                    personalBest: {
                      optics: res.optics,
                      beamLength: res.beamLength,
                      timeSec: res.timeSec,
                      solvedAt: new Date().toISOString(),
                      hintsUsed,
                    },
                  }
                : prev,
            );
            setStatusMsg(
              res.optics <= res.parOptics
                ? `Par optimal! Solved in ${res.optics} optics (Top ${res.percentile}%).`
                : `Relay locked in ${res.optics} optics (Par ${res.parOptics}). Try trimming ${res.optics - res.parOptics} optic!`,
            );
          }
        });
      }
    }
  }, [sim, puzzle, apiState, mode, placementList, elapsedSec, hintsUsed]);

  // Render high-DPI optical bench canvas (continuous soft glow only when glowEnabled)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !puzzle || !sim) return;
    let rafId = 0;

    const renderFrame = () => {
      phaseRef.current += 0.04;
      drawOpticalBench(canvas, puzzle, placements, sim, cursor, hintCellKey, phaseRef.current, glowEnabled);
      if (glowEnabled) {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    renderFrame();
    const onResize = () => {
      drawOpticalBench(canvas, puzzle, placements, sim, cursor, hintCellKey, phaseRef.current, glowEnabled);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, [puzzle, placements, sim, cursor, hintCellKey, glowEnabled]);

  const applyCellAction = useCallback(
    (r: number, c: number, overrideOptic?: OpticType | null) => {
      const key = `${r},${c}`;
      if (fixedCellSet.has(key)) {
        setStatusMsg('Fixed bench hardware cannot be overwritten.');
        return;
      }

      setPlacements((prev) => {
        const next = new Map(prev);
        const cur = prev.get(key) ?? null;
        let target: OpticType | null;

        if (overrideOptic !== undefined) {
          target = cur === overrideOptic ? null : overrideOptic;
        } else if (tool === 'erase') {
          target = null;
        } else if (tool === 'cycle') {
          const idx = cur === null ? 0 : (OPTIC_CYCLE.indexOf(cur) + 1) % OPTIC_CYCLE.length;
          target = OPTIC_CYCLE[idx];
        } else {
          target = cur === tool ? null : tool;
        }

        if (target === cur) return prev;
        setHistory((h) => [...h.slice(-39), new Map(prev)]);
        if (target === null) {
          next.delete(key);
          soundEngine.clickClear();
        } else {
          next.set(key, target);
          soundEngine.clickPlace(OPTIC_CYCLE.indexOf(target));
        }
        if (hintCellKey === key) setHintCellKey(null);
        return next;
      });
    },
    [fixedCellSet, tool, hintCellKey],
  );

  const handleUndo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setPlacements(last);
      soundEngine.clickClear();
      return prev.slice(0, -1);
    });
  }, []);

  const handleReset = useCallback(() => {
    if (placements.size === 0) return;
    setHistory((h) => [...h.slice(-39), new Map(placements)]);
    setPlacements(new Map());
    setHintCellKey(null);
    soundEngine.clickClear();
    setStatusMsg('Bench cleared.');
  }, [placements]);

  const handleHint = useCallback(() => {
    if (!puzzle) return;
    const missing = puzzle.referenceSolution.find((sol) => {
      const k = `${sol.r},${sol.c}`;
      return placements.get(k) !== sol.optic;
    });
    if (!missing) {
      setStatusMsg('All par-optimal optics are already in position. Remove extra optics to hit Par.');
      return;
    }
    const key = `${missing.r},${missing.c}`;
    setHistory((h) => [...h.slice(-39), new Map(placements)]);
    setPlacements((prev) => {
      const next = new Map(prev);
      next.set(key, missing.optic);
      return next;
    });
    setCursor({ r: missing.r, c: missing.c });
    setHintCellKey(key);
    setHintsUsed((n) => n + 1);
    soundEngine.clickPlace(2);
    setStatusMsg(
      `Hint placed ${missing.optic === 'slash' ? '/' : missing.optic === 'backslash' ? '\\' : '+'} at (${missing.r + 1}, ${missing.c + 1}).`,
    );
  }, [puzzle, placements]);

  // Keyboard shortcuts when canvas or board is active
  const handleCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((p) => ({ r: (p.r + GRID_SIZE - 1) % GRID_SIZE, c: p.c }));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((p) => ({ r: (p.r + 1) % GRID_SIZE, c: p.c }));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((p) => ({ r: p.r, c: (p.c + GRID_SIZE - 1) % GRID_SIZE }));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor((p) => ({ r: p.r, c: (p.c + 1) % GRID_SIZE }));
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        applyCellAction(cursor.r, cursor.c);
      } else if (e.key === '1') {
        e.preventDefault();
        applyCellAction(cursor.r, cursor.c, 'slash');
      } else if (e.key === '2') {
        e.preventDefault();
        applyCellAction(cursor.r, cursor.c, 'backslash');
      } else if (e.key === '3') {
        e.preventDefault();
        applyCellAction(cursor.r, cursor.c, 'splitter');
      } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
        e.preventDefault();
        applyCellAction(cursor.r, cursor.c, null);
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleReset();
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        handleHint();
      }
    },
    [cursor, applyCellAction, handleUndo, handleReset, handleHint],
  );

  const canvasCoordsToCell = (clientX: number, clientY: number): { r: number; c: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const pad = 8;
    const boardPx = rect.width - pad * 2;
    const x = clientX - rect.left - pad;
    const y = clientY - rect.top - pad;
    if (x < 0 || y < 0 || x >= boardPx || y >= boardPx) return null;
    const c = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((x / boardPx) * GRID_SIZE)));
    const r = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((y / boardPx) * GRID_SIZE)));
    return { r, c };
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = canvasCoordsToCell(e.clientX, e.clientY);
    if (!cell) return;
    setCursor(cell);
    applyCellAction(cell.r, cell.c);
  };

  const handleCanvasContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const cell = canvasCoordsToCell(e.clientX, e.clientY);
    if (!cell) return;
    setCursor(cell);
    applyCellAction(cell.r, cell.c, null);
  };

  const handleToggleMute = () => {
    setMuted((prev) => {
      const next = !prev;
      soundEngine.muted = next;
      return next;
    });
  };

  const handleShareComment = async () => {
    if (!apiState || !solveResult) return;
    setShareBusy(true);
    const res = await postShareComment(apiState.date, solveResult.shareText, apiState.isStandalone);
    setShareBusy(false);
    if (res.ok) {
      setApiState((prev) => (prev ? { ...prev, hasSharedToday: true } : prev));
      setStatusMsg(
        apiState.isStandalone
          ? 'Spoiler-free card verified in local preview (posts directly to Reddit comments in live mode).'
          : res.alreadyShared
            ? 'Your result is already posted in the comments.'
            : 'Posted spoiler-free result to Reddit comments!',
      );
    } else {
      setStatusMsg(res.error || 'Could not post comment.');
    }
  };

  const handleCopyShare = async () => {
    if (!puzzle || !sim) return;
    const text =
      solveResult?.shareText ||
      formatSpoilerFreeShare({
        puzzle,
        optics: sim.opticsUsed,
        beamLength: sim.beamLength,
        timeSec: Math.max(1, elapsedSec),
        percentile: solveResult?.percentile ?? 25,
        streak: apiState?.streak ?? 1,
        hintsUsed,
      });
    try {
      await navigator.clipboard.writeText(text);
      setStatusMsg('Copied spoiler-free result card to clipboard.');
    } catch {
      setStatusMsg(text.replace(/\n/g, ' | '));
    }
  };

  const handleClaimFlair = async () => {
    if (!apiState || !solveResult) return;
    setFlairBusy(true);
    const res = await claimUserFlair(
      apiState.date,
      solveResult.streak,
      solveResult.optics <= solveResult.parOptics,
      apiState.isStandalone,
    );
    setFlairBusy(false);
    if (res.ok && res.flairText) {
      setApiState((prev) => (prev ? { ...prev, claimedFlair: res.flairText || null } : prev));
      setStatusMsg(`Flair updated: ${res.flairText}`);
    } else {
      setStatusMsg(res.error || 'Flair unavailable in this subreddit.');
    }
  };

  const startPractice = () => {
    const nextNum = practiceCounter + 1;
    setPracticeCounter(nextNum);
    setMode('practice');
    setDateKey(`practice-${nextNum}`);
    archiveDialogRef.current?.close();
  };

  const selectArchiveDate = (d: string) => {
    setMode(d === todayUtc ? 'daily' : 'archive');
    setDateKey(d);
    archiveDialogRef.current?.close();
  };

  // Expose minimal verification handle for automated E2E inspection without polluting gameplay
  useEffect(() => {
    if (!puzzle) return;
    (window as unknown as Record<string, unknown>).__PRISM_RELAY_DEBUG__ = {
      puzzleId: puzzle.id,
      parOptics: puzzle.parOptics,
      referenceSolution: puzzle.referenceSolution,
      applyCellAction,
    };
  }, [puzzle, applyCellAction]);

  const solvedTargets = sim ? sim.targets.filter((t) => t.status === 'solved').length : 0;
  const totalTargets = puzzle ? puzzle.targets.length : 0;
  const opticsUsed = sim ? sim.opticsUsed : 0;
  const parOptics = puzzle ? puzzle.parOptics : 0;
  const archiveDates = useMemo(() => getArchiveDates(todayUtc, 14), [todayUtc]);
  const medal = puzzle ? getEfficiencyMedal(opticsUsed, parOptics) : { label: '', badge: '' };

  const histMax = apiState
    ? Math.max(
        1,
        apiState.histogram.parOrBetter,
        apiState.histogram.parPlus1,
        apiState.histogram.parPlus2,
        apiState.histogram.parPlus3Plus,
      )
    : 1;

  return (
    <main className="app-shell">
      <header className="hud-header">
        <div className="brand-group">
          <h1 className="brand-title">Prism Relay</h1>
          <span className="brand-badge">
            {mode === 'practice'
              ? `Practice #${practiceCounter}`
              : puzzle
                ? `#${puzzle.puzzleNumber} · ${apiState?.date}`
                : 'Loading…'}
          </span>
        </div>
        <div className="hud-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => statsDialogRef.current?.showModal()}
          >
            Stats
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => archiveDialogRef.current?.showModal()}
          >
            Archive
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rulesDialogRef.current?.showModal()}
          >
            Guide
          </button>
          <button type="button" className="icon-btn" onClick={handleToggleMute}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setGlowEnabled((v) => !v)}
          >
            {glowEnabled ? 'Pause Glow' : 'Resume Glow'}
          </button>
        </div>
      </header>

      <section className="telemetry-bar" aria-label="Puzzle telemetry">
        <div className="stat-pill">
          <span className="stat-label">Optics / Par</span>
          <span
            className={`stat-value ${
              opticsUsed > 0 && opticsUsed <= parOptics
                ? 'is-par'
                : opticsUsed > parOptics
                  ? 'is-over'
                  : ''
            }`}
          >
            {opticsUsed} / {parOptics || '–'}
          </span>
        </div>
        <div className="stat-pill">
          <span className="stat-label">Targets</span>
          <span className={`stat-value ${solvedTargets === totalTargets && totalTargets > 0 ? 'is-par' : ''}`}>
            {solvedTargets} / {totalTargets}
          </span>
        </div>
        <div className="stat-pill">
          <span className="stat-label">Time</span>
          <span className="stat-value">{formatDuration(elapsedSec)}</span>
        </div>
        <div className="stat-pill">
          <span className="stat-label">Streak</span>
          <span className="stat-value">{apiState ? `${apiState.streak}d` : '0d'}</span>
        </div>
      </section>

      <section className="bench-stage">
        <div className={`canvas-frame ${sim?.solved ? 'is-solved' : ''} ${glowEnabled ? 'glow-on' : ''}`}>
          <canvas
            ref={canvasRef}
            className="bench-canvas"
            tabIndex={0}
            role="application"
            aria-label="Prism Relay 7 by 7 optical grid. Use arrow keys to move and Enter or Space to place optics."
            onClick={handleCanvasClick}
            onContextMenu={handleCanvasContextMenu}
            onKeyDown={handleCanvasKeyDown}
          />
        </div>

        <div className="legend-strip" aria-label="Wavelength key">
          <span>
            <i className="dot dot-amber" />
            Amber (A)
          </span>
          <span>
            <i className="dot dot-cyan" />
            Cyan (C)
          </span>
          <span>
            <i className="dot dot-white" />
            White = A + C merged
          </span>
        </div>

        {sim?.solved && solveResult && (
          <section className="victory-banner" aria-live="polite">
            <div className="victory-top">
              <span className="victory-headline">
                {medal.badge} {medal.label} · {solveResult.optics} optics ({solveResult.beamLength}m)
              </span>
              <span className="victory-meta">
                Top {solveResult.percentile}% of {solveResult.totalClears} players · {formatDuration(solveResult.timeSec)}
              </span>
            </div>
            <div className="victory-btns">
              {mode !== 'practice' && (
                <button
                  type="button"
                  className="primary-btn"
                  disabled={shareBusy}
                  onClick={() => void handleShareComment()}
                >
                  {apiState?.hasSharedToday ? 'Shared to Comments' : shareBusy ? 'Posting…' : 'Post Result to Comments'}
                </button>
              )}
              <button type="button" className="icon-btn" onClick={() => void handleCopyShare()}>
                Copy Card
              </button>
              {mode !== 'practice' && (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={flairBusy}
                  onClick={() => void handleClaimFlair()}
                >
                  {apiState?.claimedFlair ? `Flair: ${apiState.claimedFlair}` : 'Claim Streak Flair'}
                </button>
              )}
              <button type="button" className="icon-btn" onClick={startPractice}>
                Next Practice
              </button>
            </div>
          </section>
        )}

        <div className="tool-dock" role="toolbar" aria-label="Optic controls">
          <div className="tool-group">
            <button
              type="button"
              className="tool-btn"
              aria-pressed={tool === 'cycle'}
              onClick={() => setTool('cycle')}
            >
              Cycle
            </button>
            <button
              type="button"
              className="tool-btn"
              aria-pressed={tool === 'slash'}
              onClick={() => setTool('slash')}
              title="Mirror / (Key 1)"
            >
              / Mirror
            </button>
            <button
              type="button"
              className="tool-btn"
              aria-pressed={tool === 'backslash'}
              onClick={() => setTool('backslash')}
              title="Mirror \ (Key 2)"
            >
              \ Mirror
            </button>
            <button
              type="button"
              className="tool-btn"
              aria-pressed={tool === 'splitter'}
              onClick={() => setTool('splitter')}
              title="Beam Splitter + (Key 3)"
            >
              + Split
            </button>
            <button
              type="button"
              className="tool-btn"
              aria-pressed={tool === 'erase'}
              onClick={() => setTool('erase')}
            >
              Erase
            </button>
          </div>
          <div className="tool-group">
            <button type="button" className="icon-btn" onClick={handleUndo} disabled={history.length === 0}>
              Undo
            </button>
            <button type="button" className="icon-btn" onClick={handleHint}>
              Hint
            </button>
            <button type="button" className="icon-btn" onClick={handleReset} disabled={placements.size === 0}>
              Reset
            </button>
          </div>
        </div>

        <p className="toast-status" role="status" aria-live="polite">
          {statusMsg}
        </p>
      </section>

      {/* Stats & Subreddit Distribution Dialog */}
      <dialog
        ref={statsDialogRef}
        className="pr-dialog"
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="statsDialogTitle"
      >
        <div className="dialog-head">
          <h2 id="statsDialogTitle">Subreddit Distribution & Top 10</h2>
          <form method="dialog">
            <button type="submit" className="icon-btn">
              Close
            </button>
          </form>
        </div>
        {apiState && (
          <>
            <p className="victory-meta">
              {apiState.totalClears} clears on {apiState.date} · Your streak: {apiState.streak}d (best {apiState.bestStreak}d)
            </p>
            <div className="hist-list" aria-label="Optic count distribution">
              {[
                { label: `≤ Par (${parOptics})`, count: apiState.histogram.parOrBetter },
                { label: `Par + 1`, count: apiState.histogram.parPlus1 },
                { label: `Par + 2`, count: apiState.histogram.parPlus2 },
                { label: `Par + 3+`, count: apiState.histogram.parPlus3Plus },
              ].map((row) => (
                <div className="hist-row" key={row.label}>
                  <span>{row.label}</span>
                  <div className="hist-track">
                    <div
                      className="hist-fill"
                      style={{ width: `${Math.round((row.count / histMax) * 100)}%` }}
                    />
                  </div>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
            <table className="lb-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Optics</th>
                  <th>Beam</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {apiState.leaderboard.map((entry) => (
                  <tr key={`${entry.rank}-${entry.username}`} className={entry.isCurrentUser ? 'is-me' : ''}>
                    <td>{entry.rank}</td>
                    <td>u/{entry.username}</td>
                    <td>{entry.optics}</td>
                    <td>{entry.beamLength}m</td>
                    <td>{formatDuration(entry.timeSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </dialog>

      {/* 14-Day Archive & Unlimited Practice Dialog */}
      <dialog
        ref={archiveDialogRef}
        className="pr-dialog"
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="archiveDialogTitle"
      >
        <div className="dialog-head">
          <h2 id="archiveDialogTitle">Daily Archive & Practice</h2>
          <form method="dialog">
            <button type="submit" className="icon-btn">
              Close
            </button>
          </form>
        </div>
        <button type="button" className="primary-btn" onClick={startPractice}>
          Launch New Practice Board
        </button>
        <div className="archive-grid">
          {archiveDates.map((d) => (
            <button
              key={d}
              type="button"
              className={`archive-item ${dateKey === d ? 'is-active' : ''}`}
              onClick={() => selectArchiveDate(d)}
            >
              <span>{d === todayUtc ? 'Today (UTC)' : d}</span>
              <span>Play</span>
            </button>
          ))}
        </div>
      </dialog>

      {/* Concise Rules Dialog */}
      <dialog
        ref={rulesDialogRef}
        className="pr-dialog"
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="rulesDialogTitle"
      >
        <div className="dialog-head">
          <h2 id="rulesDialogTitle">How to Play Prism Relay</h2>
          <form method="dialog">
            <button type="submit" className="icon-btn">
              Close
            </button>
          </form>
        </div>
        <ul className="rules-list">
          <li>
            <strong>Match every photodiode:</strong> Route Amber (A) beams to A diodes, Cyan (C) beams to C diodes, and merge <strong>both A + C</strong> onto White (A+C) diodes.
          </li>
          <li>
            <strong>Avoid cross-talk:</strong> An Amber-only diode rejects Cyan light (and vice versa).
          </li>
          <li>
            <strong>Optics:</strong> <code>/</code> and <code>\</code> mirrors bend rays 90°. <code>+</code> splitters fire perpendicular rays in both directions.
          </li>
          <li>
            <strong>Beat Par:</strong> Every UTC daily board is solver-verified for its true minimum optic count. Clear it with ≤ Par optics for a Gold Star and Top percentile!
          </li>
          <li>
            <strong>Keyboard:</strong> Arrow keys move, Space/Enter cycles, <code>1</code>/<code>2</code>/<code>3</code> place <code>/</code>, <code>\</code>, <code>+</code>, Delete clears, <code>Z</code> undoes, <code>H</code> places 1 par-optimal hint.
          </li>
        </ul>
      </dialog>
    </main>
  );
}
