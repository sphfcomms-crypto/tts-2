// Her body language.
//
// She is filmed in short clips ("units"): listening, nodding, an open-hand
// gesture, a hand on her chest, a shrug, a wave, a thoughtful look. Every
// unit starts and ends in the same seated pose, so any one can follow any
// other without a jump. The director plays them back to back, for ever,
// and chooses each next one by what she is doing: listening, thinking, or
// speaking (then she gestures).
//
// It also answers the question the lip sync needs answered: which unit, and
// which frame of it, will be on screen at a given moment a second or two
// from now. Her speech is then drawn on exactly those frames, so her mouth
// moves on top of whatever her body is doing.

export type Pool = "listen" | "talk" | "greet" | "think";
export type Unit = {
  name: string;
  frames: number;
  pool: Pool;
  file: string;
  // Her own mouth moves in this clip (the generator made her talk). It is
  // only ever shown redrawn by the lip sync, never as it is.
  mouths?: boolean;
};

export const FPS = 25;
// How far ahead the next units are always decided. Speech is drawn about a
// second before it is seen, so the plan must reach further than that.
const AHEAD = 2.6;

type Slot = { unit: Unit; start: number; shown: boolean };

// The director's clock, in seconds.
export const stageClock = () => performance.now() / 1000;

export class Director {
  // What she is doing; the next unit is chosen to suit it.
  want: "listen" | "talk" | "think" = "listen";
  // She has just met the caller: the next unit is a greeting.
  greet = false;

  private slots: Slot[] = [];
  private timer = 0;
  private front = 0; // which of the two players shows the current unit
  private loaded: (Unit | null)[] = [null, null];

  // players: two video elements, one on top of the other. One shows the
  // current unit while the other has the next one ready.
  constructor(
    private players: [HTMLVideoElement, HTMLVideoElement],
    private units: Unit[],
    private show: (front: number) => void
  ) {}

  start() {
    const first = this.choose();
    this.slots = [{ unit: first, start: stageClock(), shown: true }];
    this.load(0, first);
    this.players[0].play().catch(() => {});
    this.show(0);
    this.timer = window.setInterval(() => this.tick(), 30);
  }

  stop() {
    window.clearInterval(this.timer);
    for (const player of this.players) player.pause();
  }

  // The unit and frame that will be on screen at time t, and how many
  // frames of that unit are left from there (that frame included).
  at(t: number): { unit: Unit; frame: number; left: number } {
    this.plan(t);
    let slot = this.slots[0];
    for (const candidate of this.slots) {
      if (candidate.start <= t) slot = candidate;
    }
    const frame = Math.max(
      0,
      Math.min(slot.unit.frames - 1, Math.round((t - slot.start) * FPS))
    );
    return { unit: slot.unit, frame, left: slot.unit.frames - frame };
  }

  private end(slot: Slot) {
    return slot.start + slot.unit.frames / FPS;
  }

  // Decides units until the plan reaches time `until`.
  private plan(until: number) {
    let last = this.slots[this.slots.length - 1];
    while (this.end(last) < until) {
      last = { unit: this.choose(last.unit), start: this.end(last), shown: false };
      this.slots.push(last);
    }
  }

  private choose(previous?: Unit): Unit {
    let pool: Pool = this.want;
    if (this.greet && this.units.some((unit) => unit.pool === "greet")) {
      this.greet = false;
      pool = "greet";
    }
    let choice = this.units.filter((unit) => unit.pool === pool);
    if (!choice.length) choice = this.units.filter((unit) => unit.pool === "listen");
    if (!choice.length) choice = this.units;
    // Not the same movement twice running, when there is another.
    if (choice.length > 1) choice = choice.filter((unit) => unit !== previous);
    return choice[Math.floor(Math.random() * choice.length)];
  }

  private load(player: number, unit: Unit) {
    if (this.loaded[player] === unit) return;
    this.loaded[player] = unit;
    const video = this.players[player];
    video.src = unit.file;
    video.load();
  }

  private tick() {
    const t = stageClock();
    this.plan(t + AHEAD);

    // The unit whose turn has come moves to the front.
    const due = this.slots.find((slot) => !slot.shown && slot.start <= t);
    if (due) {
      due.shown = true;
      const back = 1 - this.front;
      this.load(back, due.unit);
      const video = this.players[back];
      video.currentTime = Math.min(Math.max(0, t - due.start), due.unit.frames / FPS);
      video.play().catch(() => {});
      this.show(back);
      this.players[this.front].pause();
      this.front = back;
    }

    // Forget what is over; keep the one on screen.
    while (this.slots.length > 1 && this.slots[1].start <= t && this.slots[1].shown) {
      this.slots.shift();
    }

    // Have the following unit ready behind, and keep the one in front on
    // time (a video element drifts a little, and stalls in a hidden tab).
    const [current, next] = this.slots;
    if (next && !next.shown) this.load(1 - this.front, next.unit);
    const video = this.players[this.front];
    const want = t - current.start;
    if (want < current.unit.frames / FPS && Math.abs(video.currentTime - want) > 0.12) {
      video.currentTime = want;
      if (video.paused) video.play().catch(() => {});
    }
  }
}
