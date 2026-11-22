// Deadlines use the same AudioContext clock as the live speech and its
// scheduled video. A quiet caller can wait indefinitely for the first reply.
export class CallVideoHealth {
  private firstDue = Infinity;
  private receivedFrame = false;
  private missingSince: number | null = null;
  private latePieces = 0;

  expect(due: number) {
    this.firstDue = Math.min(this.firstDue, due);
  }

  joined(secondsLate: number) {
    if (!Number.isFinite(this.firstDue)) return false;
    this.latePieces = secondsLate >= 2 ? this.latePieces + 1 : 0;
    return this.latePieces >= 3;
  }

  missedDeadline(now: number, due: boolean, shown: boolean) {
    if (!Number.isFinite(this.firstDue)) return false;
    if (shown) this.receivedFrame = true;
    if (due && !shown) this.missingSince ??= now;
    else this.missingSince = null;
    return (!this.receivedFrame && now >= this.firstDue + 2) ||
      (this.missingSince !== null && now - this.missingSince >= 2);
  }
}
