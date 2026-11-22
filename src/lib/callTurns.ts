// GPT-Live sends pieces of the transcript on a session clock. The two
// speakers can overlap, and neither track sends an "end of turn" event.
export type TranscriptSpan = { startMs: number; endMs: number };

export function transcriptSpan(start: unknown, end: unknown): TranscriptSpan | undefined {
  if (
    typeof start === "number" && typeof end === "number" &&
    Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
  ) {
    return { startMs: start, endMs: end };
  }
}

type Speech = {
  update(text: string, span?: TranscriptSpan): void;
  clear(): void;
};

export class CallTurns {
  private line = "";
  private outputEnd = -Infinity;
  private callerEnd = -Infinity;
  private clearedThrough = -Infinity;
  waitingForReply = false;

  constructor(private readonly speech: Speech) {}

  // Caption history is kept independently. Late words from an interrupted
  // reply still belong there but must never animate the next reply.
  assistant(delta: string, span?: TranscriptSpan): boolean {
    if (!delta || (span && (span.startMs < this.clearedThrough || span.endMs < this.outputEnd))) {
      return false;
    }
    const newTurn = span && (
      span.startMs - this.outputEnd > 1200 ||
      (this.callerEnd > this.outputEnd && span.startMs >= this.callerEnd)
    );
    if (this.line && newTurn) {
      this.line = "";
      this.speech.clear();
    }
    this.waitingForReply = false;
    this.line += delta;
    if (span) this.outputEnd = span.endMs;
    this.speech.update(this.line, span);
    return true;
  }

  // An old input fragment can arrive after a newer reply has begun. The
  // caller's actual microphone activity corroborates a fresh interruption.
  caller(span: TranscriptSpan | undefined, heardRecently: boolean): boolean {
    const previous = this.callerEnd;
    if (span) this.callerEnd = Math.max(this.callerEnd, span.endMs);
    if (!heardRecently || (span && (span.endMs <= previous || span.endMs <= this.outputEnd))) {
      return false;
    }
    this.waitingForReply = true;
    if (span) this.clearedThrough = Math.max(this.clearedThrough, span.endMs);
    if (this.line) {
      this.line = "";
      this.speech.clear();
    }
    return true;
  }
}
