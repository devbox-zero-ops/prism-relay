/**
 * Zero-asset Web Audio API tactile sound synthesizer for Prism Relay.
 * Fails silently in headless or restricted audio contexts.
 */
class SynthAudio {
  private ctx: AudioContext | null = null;
  public muted = false;

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private playTone(
    freq: number,
    durationSec: number,
    gainPeak: number,
    type: OscillatorType = 'sine',
    delaySec = 0,
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  public clickPlace(opticIdx: number): void {
    const freqs = [330, 440, 494, 587];
    this.playTone(freqs[opticIdx % freqs.length], 0.08, 0.07, 'triangle');
  }

  public clickClear(): void {
    this.playTone(220, 0.07, 0.05, 'sine');
  }

  public targetLock(count: number): void {
    const scale = [523.25, 659.25, 783.99, 1046.5];
    const freq = scale[Math.min(scale.length - 1, Math.max(0, count - 1))];
    this.playTone(freq, 0.18, 0.08, 'sine');
  }

  public victoryChord(): void {
    // C5 -> E5 -> G5 -> C6 harmonic arpeggio
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, idx) => {
      this.playTone(f, 0.32, 0.08, 'triangle', idx * 0.07);
    });
  }
}

export const soundEngine = new SynthAudio();
