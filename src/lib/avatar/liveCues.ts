// Live transcript intervals are approximate and use the session's clock.
// Anchor the first one to the voice heard on this device. Subsequent intervals
// retain their relative timing, including gaps between phrases.
import { articulate, sampleSpeech, supportsArticulation, type TimedViseme, type VisemeBlend } from "./articulation";
import { transcriptSpan, type TranscriptSpan } from "../callTurns";

export class LiveCues {
  private text = "";
  private cues: TimedViseme[] = [];
  private origin: number | null = null;
  private end = 0;
  private unknownDuration = false;
  private unknownTail = false;
  private tail: { word: string; index: number; start: number } | null = null;
  private wave = new Float32Array(0);
  private lastFrame: number | null = null;
  private lastSound = -Infinity;
  private onset: number | null = null;
  private elapsed = 0;

  clear() {
    this.text = "";
    this.cues = [];
    this.origin = null;
    this.end = 0;
    this.unknownDuration = false;
    this.unknownTail = false;
    this.tail = null;
    this.lastFrame = null;
    this.lastSound = -Infinity;
    this.onset = null;
    this.elapsed = 0;
  }

  update(text: string, span?: TranscriptSpan) {
    if (text === this.text) return;
    if (!text.startsWith(this.text)) this.clear();
    const delta = text.slice(this.text.length);
    this.text = text;

    const timing = transcriptSpan(span?.startMs, span?.endMs);
    let start = this.end;
    let until: number | undefined;
    if (timing && (!this.unknownDuration || this.origin !== null)) {
      this.origin ??= timing.startMs / 1000 - this.end;
      start = Math.max(this.end, timing.startMs / 1000 - this.origin);
      until = timing.endMs / 1000 - this.origin;
      if (until <= start) return;
      this.unknownDuration = false;
    }
    const unsupported = !supportsArticulation(delta) ||
      (this.unknownTail && /^\S/u.test(delta));
    this.unknownTail = unsupported && /\S$/u.test(delta);
    if (unsupported || this.unknownDuration) {
      // A number, symbol or unfamiliar script can sound very different from
      // its spelling. Leave the entire fragment to the acoustic mouth model.
      this.tail = null;
      if (until === undefined) this.unknownDuration = true;
      else this.end = until;
      return;
    }

    const words = delta.match(/\S+/gu) ?? [];
    const parts = words.map(word => {
      const phones = articulate(word);
      return { word, phones, weight: phones.reduce((sum, p) => sum + p.weight, 0) };
    });
    const weight = parts.reduce((sum, part) => sum + part.weight, 0);
    const end = until ?? start + weight;
    const continuation = /^\S/u.test(delta) && start - this.end < 0.15 ? this.tail : null;
    this.tail = null;
    this.end = end;
    let at = start;
    for (const [i, part] of parts.entries()) {
      const until = at + (end - start) * (weight ? part.weight / weight : 0);
      let { word, phones } = part;
      if (!i && continuation) {
        // A network fragment may finish a digraph such as “sh” or “بھ”.
        // Replan just that word, retaining its original start.
        this.cues.length = continuation.index;
        word = continuation.word + word;
        at = continuation.start;
        phones = articulate(word);
      }
      const index = this.cues.length;
      const wordStart = at;
      const total = phones.reduce((sum, p) => sum + p.weight, 0);
      for (const p of phones) {
        const next = at + (until - wordStart) * p.weight / total;
        if (next > at) this.cues.push({ viseme: p.viseme, start: at, end: next });
        at = next;
      }
      at = until;
      if (i === parts.length - 1 && /\S$/u.test(delta)) {
        this.tail = { word, index, start: wordStart };
      }
    }
  }

  sample(voice: AnalyserNode): VisemeBlend | null {
    if (this.wave.length !== voice.fftSize) this.wave = new Float32Array(voice.fftSize);
    voice.getFloatTimeDomainData(this.wave);
    let energy = 0;
    for (const value of this.wave) energy += value * value;
    const audible = energy > this.wave.length * 0.012 ** 2;
    const now = voice.context.currentTime;
    const dt = this.lastFrame === null ? 0 : Math.max(0, now - this.lastFrame);
    this.lastFrame = now;

    if (audible && !this.text && now - this.lastSound > 0.65) {
      // Noise or a prior utterance before the first caption.
      this.onset = null;
      this.elapsed = 0;
    }
    // Without timestamps, count spoken time plus short consonant closures.
    if (this.onset !== null && (audible || now - this.lastSound < 0.045)) this.elapsed += dt;
    if (!audible) return null;
    this.onset ??= now;
    this.lastSound = now;
    return sampleSpeech(this.cues, this.origin === null ? this.elapsed : now - this.onset);
  }
}
