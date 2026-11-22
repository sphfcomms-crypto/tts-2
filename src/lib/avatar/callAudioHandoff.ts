import type { VisemeBlend } from "./articulation";

// Voice already in the delay line must still be heard when the video drops.
// Allow a normal phrase break first. For uninterrupted speech, gently shorten
// the delay (at most 10% faster) so the source position advances continuously.
export class CallAudioHandoff {
  private quietSince: number | null = null;
  private readonly rampEnd: number;

  constructor(private readonly initial: number, at: number, delay: AudioParam) {
    const rampStart = at + 2;
    this.rampEnd = rampStart + initial / 0.1;
    delay.cancelScheduledValues(at);
    delay.setValueAtTime(initial, at);
    delay.setValueAtTime(initial, rampStart);
    delay.linearRampToValueAtTime(0, this.rampEnd);
  }

  remaining(at: number) {
    return Math.min(this.initial, Math.max(0, (this.rampEnd - at) * 0.1));
  }

  drained(at: number, silent: boolean) {
    if (!silent) this.quietSince = null;
    else this.quietSince ??= at;
    return at >= this.rampEnd ||
      (this.quietSince !== null && at - this.quietSince >= this.remaining(at) + 0.15);
  }
}

// Capture direct-track articulation before a failure. During the handoff
// sample the word shapes for the audio that is actually at the speaker.
export class CallCueHistory {
  private entries: { at: number; shape: VisemeBlend | null; phrase: string }[] = [];

  record(at: number, shape: VisemeBlend | null, phrase: string) {
    // The context clock can stop while the page is in the background.
    if (this.entries[this.entries.length - 1]?.at === at) return;
    this.entries.push({ at, shape, phrase });
    while (this.entries.length && this.entries[0].at < at - 5) this.entries.shift();
  }

  at(time: number) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].at <= time) return this.entries[i];
    }
  }
}
