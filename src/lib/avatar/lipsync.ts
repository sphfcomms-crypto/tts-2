// Mouth shapes from the sound of her voice, as it plays.
//
// There is no text or phoneme timing to go on in a live call, so the mouth
// is driven by the sound itself: how loud it is and where its energy sits.
//   - loudness opens the jaw;
//   - energy low in the spectrum with little above 1 kHz is a rounded vowel
//     (o, u): the lips funnel;
//   - strong energy between 1 and 3 kHz is a front vowel (e, i): the lips
//     spread;
//   - energy mostly above 3.5 kHz is a hiss (s, sh, ch): teeth together;
//   - a short dip to silence between two voiced stretches is a closed
//     consonant (p, b, m): the lips press shut.

export type Mouth = {
  // 0 silent to 1 loud, smoothed: also drives nods and gestures.
  level: number;
  // True while she is making sound.
  voiced: boolean;
  // ARKit morph weights for this frame.
  shapes: Record<string, number>;
};

const SILENCE = 0.012; // RMS below this is not speech

export class LipSync {
  private time = new Float32Array(1024);
  private freq = new Uint8Array(512);
  private level = 0;
  private open = 0;
  private round = 0;
  private spread = 0;
  private hiss = 0;
  private press = 0;
  private quietFor = 1;
  private loudFor = 0;

  // dt: seconds since the last frame.
  update(analyser: AnalyserNode | null, dt: number): Mouth {
    let rms = 0;
    let low = 0;
    let mid = 0;
    let high = 0;

    if (analyser) {
      if (this.time.length !== analyser.fftSize) {
        this.time = new Float32Array(analyser.fftSize);
        this.freq = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getFloatTimeDomainData(this.time);
      analyser.getByteFrequencyData(this.freq);

      let sum = 0;
      for (let i = 0; i < this.time.length; i++) sum += this.time[i] ** 2;
      rms = Math.sqrt(sum / this.time.length);

      const hz = analyser.context.sampleRate / analyser.fftSize;
      const band = (from: number, to: number) => {
        const a = Math.max(1, Math.round(from / hz));
        const b = Math.min(this.freq.length - 1, Math.round(to / hz));
        let total = 0;
        for (let i = a; i <= b; i++) total += this.freq[i];
        return total / (255 * Math.max(1, b - a + 1));
      };
      low = band(150, 1000);
      mid = band(1000, 3000);
      high = band(3500, 9000);
    }

    const voiced = rms > SILENCE;
    if (voiced) {
      // A closed consonant: sound resumes after a very short silence.
      if (this.quietFor > 0.03 && this.quietFor < 0.16 && this.loudFor > 0.08) {
        this.press = 1;
      }
      this.loudFor += dt;
      this.quietFor = 0;
    } else {
      this.quietFor += dt;
      if (this.quietFor > 0.3) this.loudFor = 0;
    }

    // Loudness on a curve that makes ordinary speech open the mouth well.
    const loud = voiced ? Math.min(1, Math.pow(rms / 0.16, 0.6)) : 0;
    const total = low + mid + high + 1e-4;
    const hissNow = voiced ? clamp01((high / total - 0.42) * 3.2) : 0;
    const roundNow = voiced ? clamp01((low / total - 0.5) * 2.6) * (1 - hissNow) : 0;
    const spreadNow = voiced ? clamp01((mid / total - 0.34) * 3.2) * (1 - hissNow) : 0;

    // The mouth opens fast and closes a little slower, like a real jaw.
    this.open = approach(this.open, loud, dt, loud > this.open ? 0.035 : 0.075);
    this.round = approach(this.round, roundNow, dt, 0.06);
    this.spread = approach(this.spread, spreadNow, dt, 0.06);
    this.hiss = approach(this.hiss, hissNow, dt, 0.04);
    this.press = approach(this.press, 0, dt, 0.07);
    this.level = approach(this.level, loud, dt, 0.12);

    const open = this.open * (1 - 0.75 * this.hiss) * (1 - this.press);
    const jaw = open * (0.34 + 0.2 * (1 - this.round) - 0.1 * this.spread);
    const shapes: Record<string, number> = {
      jawOpen: jaw,
      mouthFunnel: 0.55 * this.round * open,
      mouthPucker: 0.35 * this.round * open,
      mouthStretchLeft: 0.3 * this.spread * open + 0.25 * this.hiss,
      mouthStretchRight: 0.3 * this.spread * open + 0.25 * this.hiss,
      mouthSmileLeft: 0.18 * this.spread * open,
      mouthSmileRight: 0.18 * this.spread * open,
      mouthLowerDownLeft: 0.32 * open * (1 - this.round) + 0.2 * this.hiss,
      mouthLowerDownRight: 0.32 * open * (1 - this.round) + 0.2 * this.hiss,
      mouthUpperUpLeft: 0.14 * open * (1 - this.round) + 0.12 * this.hiss,
      mouthUpperUpRight: 0.14 * open * (1 - this.round) + 0.12 * this.hiss,
      mouthClose: 0.1 * this.press,
      mouthPressLeft: 0.5 * this.press,
      mouthPressRight: 0.5 * this.press,
      mouthRollLower: 0.2 * this.press,
    };

    return { level: this.level, voiced, shapes };
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Moves a value towards its target; `time` is roughly how long 63% takes.
export function approach(value: number, target: number, dt: number, time: number) {
  return target + (value - target) * Math.exp(-dt / Math.max(1e-4, time));
}
