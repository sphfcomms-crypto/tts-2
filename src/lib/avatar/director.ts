// Her body language.
//
// She is filmed in short clips ("units"): listening, nodding, an open-hand
// gesture, a hand on her chest, a shrug, a wave, a thoughtful look. Every
// unit starts and ends in the same seated pose, so any one can follow any
// other without a jump. The director plays them back to back, for ever,
// and chooses each next one by what she is doing: listening, thinking, or
// speaking (then she gestures).
//
// It does not wait for a unit to end before it follows her. When she
// begins to speak, the unit she is in is cut short so that a gesture
// starts with her voice; when she stops, the gesture she is in is wrapped
// up (the picture skips to where her hands go back to her lap) instead of
// being held for seconds over silence. Such a cut is a short dissolve.
//
// It also answers the question the lip sync needs answered: which unit, and
// which frame of it, will be on screen at a given moment a second or two
// from now. Her speech is then drawn on exactly those frames, so her mouth
// moves on top of whatever her body is doing. What her lips have been
// drawn on is never changed afterwards (see claim).

export type Pool = "listen" | "talk" | "greet" | "think";
export type Want = "listen" | "talk" | "think";
export type Unit = {
  name: string;
  frames: number;
  pool: Pool;
  file: string;
  // Her own mouth moves in this clip (the generator made her talk). It is
  // only ever shown redrawn by the lip sync, never as it is.
  mouths?: boolean;
  // The frame at which she leaves the rest pose, and the frame from which
  // she returns to it (her hands start back to her lap). Between the two
  // she is in the middle of the movement. Absent: she hardly moves at all.
  rise?: number;
  release?: number;
  // The clip, held in memory, once it has been fetched. Only units that
  // have one are played: a clip streamed over a slow line stalls.
  url?: string;
};

export const FPS = 25;
// How long a dissolve between two different poses takes, in milliseconds.
export const DISSOLVE = 220;
// How far ahead the next units are always decided. Speech is drawn about a
// second before it is seen, so the plan must reach further than that.
const AHEAD = 2.6;
// A change of plan needs this long to be made ready behind the picture.
const PREPARE = 0.35;
// Less than this many frames of a unit are not worth cutting off or keeping.
const SHORTEST = 12;
// A gesture clip is begun this long before her voice: her hands start to
// move a little after the clip does.
const LEAD_IN = 0.3;

type Slot = {
  unit: Unit;
  start: number; // when its first frame shown (`from`) is on screen
  from: number; // the first frame shown
  to: number; // one past the last frame shown
  soft: boolean; // the picture before it is in another pose: dissolve into it
  shown: boolean;
};

// The director's clock, in seconds.
export const stageClock = () => performance.now() / 1000;

const suits = (unit: Unit, want: Want) =>
  want === "talk" ? unit.pool === "talk" || unit.pool === "greet" : unit.pool === want;

export class Director {
  // What she is doing; the next unit is chosen to suit it. Set with turn().
  want: Want = "listen";
  // She has just met the caller: the next gesture is a greeting.
  greet = false;

  private slots: Slot[] = [];
  private timer = 0;
  private front = 0; // which of the two players shows the current unit
  private loaded: (Unit | null)[] = [null, null];
  private claimed = 0; // her lips have been asked for up to this moment
  private softNext = false; // the next unit planned follows a cut

  // players: two video elements, one on top of the other. One shows the
  // current unit while the other has the next one ready.
  // show(front, soft): bring that player to the front, at once or through
  // a dissolve.
  constructor(
    private players: [HTMLVideoElement, HTMLVideoElement],
    private units: Unit[],
    private show: (front: number, soft: boolean) => void
  ) {}

  get running() {
    return this.slots.length > 0;
  }

  start() {
    if (this.running) return;
    const first = this.choose();
    this.slots = [
      { unit: first, start: stageClock(), from: 0, to: first.frames, soft: false, shown: true },
    ];
    this.load(0, first);
    this.players[0].play().catch(() => {});
    this.show(0, false);
    this.timer = window.setInterval(() => this.tick(), 30);
  }

  stop() {
    window.clearInterval(this.timer);
    this.slots = [];
    for (const player of this.players) player.pause();
  }

  // The unit and frame that will be on screen at time t, and how many
  // frames of that unit are left from there (that frame included).
  at(t: number): { unit: Unit; frame: number; left: number } {
    this.plan(t);
    const slot = this.slotAt(t);
    const frame = Math.max(
      slot.from,
      Math.min(slot.to - 1, slot.from + Math.round((t - slot.start) * FPS))
    );
    return { unit: slot.unit, frame, left: slot.to - frame };
  }

  // Her lips have been asked for up to this moment: the plan up to it is
  // fixed from now on.
  claim(until: number) {
    this.claimed = Math.max(this.claimed, until);
  }

  // She starts doing something else. by: the moment her voice will first
  // be heard (when she begins to speak); a gesture then starts with it.
  turn(want: Want, by?: number) {
    this.want = want;
    if (!this.running) return;
    const now = stageClock();
    // Nothing that is about to be shown, or that her lips are already
    // drawn on, is changed.
    const free = Math.max(now + PREPARE, this.claimed);
    this.plan(free);
    const current = this.slotAt(free);
    // Whatever was planned after it is decided again by what she does now.
    // (A greeting that was planned and is dropped here is still owed.)
    if (this.slots.some((slot) => slot.start > current.start && slot.unit.pool === "greet")) {
      this.greet = true;
    }
    this.slots = this.slots.filter((slot) => slot.start <= current.start);
    this.softNext = false;
    if (suits(current.unit, want)) return;

    const unit = current.unit;
    const rise = unit.rise ?? unit.frames;
    const release = unit.release ?? 0;
    const moving = unit.rise !== undefined && unit.release !== undefined;
    const back = moving ? (unit.frames - release) / FPS : 0; // her way back to rest

    // Where the unit is cut. For speech, so that the gesture clip starts
    // just before her voice (allowing for her way back from this pose).
    let when = free;
    if (by !== undefined) when = Math.max(free, by - LEAD_IN - back);
    let frame = current.from + Math.ceil((when - current.start) * FPS);
    if (by !== undefined && moving && frame <= rise) {
      // She has not left the rest pose yet: no way back is needed.
      when = Math.max(free, by - LEAD_IN);
      frame = current.from + Math.ceil((when - current.start) * FPS);
    }
    if (current.to - frame < SHORTEST) return; // it is over in a moment anyway

    if (moving && frame > rise) {
      if (frame >= release - SHORTEST) return; // already on her way back
      // In the middle of the movement: skip to her way back to rest.
      current.to = frame;
      this.slots.push({
        unit,
        start: this.end(current),
        from: release,
        to: unit.frames,
        soft: true,
        shown: false,
      });
      return;
    }
    // At rest (or hardly moving): straight on to what suits her now.
    current.to = Math.max(current.from + 1, frame);
    this.softNext = true;
    // A greeting cut off before her hand has moved has not been given.
    if (unit.pool === "greet") this.greet = true;
  }

  private slotAt(t: number) {
    let slot = this.slots[0];
    for (const candidate of this.slots) {
      if (candidate.start <= t) slot = candidate;
    }
    return slot;
  }

  private end(slot: Slot) {
    return slot.start + (slot.to - slot.from) / FPS;
  }

  // Decides units until the plan reaches time `until`.
  private plan(until: number) {
    let last = this.slots[this.slots.length - 1];
    while (this.end(last) < until) {
      const unit = this.choose(last.unit);
      last = {
        unit,
        start: this.end(last),
        from: 0,
        to: unit.frames,
        soft: this.softNext,
        shown: false,
      };
      this.softNext = false;
      this.slots.push(last);
    }
  }

  private choose(previous?: Unit): Unit {
    const ready = this.units.filter((unit) => unit.url);
    let pool: Pool = this.want;
    if (this.greet && ready.some((unit) => unit.pool === "greet")) {
      this.greet = false;
      pool = "greet";
    }
    let choice = ready.filter((unit) => unit.pool === pool);
    if (!choice.length) choice = ready.filter((unit) => unit.pool === "listen");
    if (!choice.length) choice = ready;
    // Not the same movement twice running, when there is another.
    if (choice.length > 1) choice = choice.filter((unit) => unit !== previous);
    return choice[Math.floor(Math.random() * choice.length)];
  }

  private load(player: number, unit: Unit) {
    if (this.loaded[player] === unit) return;
    this.loaded[player] = unit;
    const video = this.players[player];
    video.dataset.unit = unit.name; // for anyone looking at the page: which clip this is
    video.src = unit.url!;
    video.load();
  }

  // Has the player hold the slot's first frame, ready to be shown.
  private cue(player: number, slot: Slot) {
    this.load(player, slot.unit);
    const video = this.players[player];
    const at = slot.from / FPS;
    if (video.paused && !video.seeking && Math.abs(video.currentTime - at) > 0.02) {
      video.currentTime = at;
    }
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
      const want = due.from / FPS + Math.max(0, t - due.start);
      if (Math.abs(video.currentTime - want) > 0.04) video.currentTime = want;
      video.play().catch(() => {});
      this.show(back, due.soft);
      const old = this.players[this.front];
      // Through a dissolve the picture underneath keeps moving until it
      // is covered.
      if (due.soft) window.setTimeout(() => this.rest(old), DISSOLVE + 40);
      else old.pause();
      this.front = back;
    }

    // Forget what is over; keep the one on screen.
    while (this.slots.length > 1 && this.slots[1].start <= t && this.slots[1].shown) {
      this.slots.shift();
    }

    // Have the following unit ready behind, and keep the one in front on
    // time (a video element drifts a little, and stalls in a hidden tab).
    // A player that is still finding its place is left alone: asking again
    // only makes it start over.
    const [current, next] = this.slots;
    if (next && !next.shown && t > current.start + (DISSOLVE + 80) / 1000) {
      this.cue(1 - this.front, next);
    }
    const video = this.players[this.front];
    const want = current.from / FPS + (t - current.start);
    if (t < this.end(current) && !video.seeking && video.readyState >= 2) {
      if (Math.abs(video.currentTime - want) > 0.12) video.currentTime = want;
      if (video.paused) video.play().catch(() => {});
    }
  }

  // Stops a player that is no longer in front.
  private rest(video: HTMLVideoElement) {
    if (video !== this.players[this.front]) video.pause();
  }
}
