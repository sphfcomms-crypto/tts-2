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

// idle: nobody is speaking and she is not being spoken to. listen: she is
// being spoken to (a call, or the microphone is on).
export type Pool = "idle" | "listen" | "talk" | "greet" | "think";
export type Want = "idle" | "listen" | "talk" | "think";
export type Unit = {
  name: string;
  frames: number;
  pool: Pool;
  // Other moments it also suits (a quiet listening clip also suits idling).
  also?: Pool[];
  // How often it is chosen against the others of its pool (1 when absent):
  // a large movement, like tidying her dupatta, is for now and then.
  weight?: number;
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
export const DISSOLVE = 140;
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
  wrap?: boolean; // her way back to rest after a movement was cut short
};

// The director's clock, in seconds.
export const stageClock = () => performance.now() / 1000;

// The speed at which a video that is `behind` seconds late (or early, when
// negative) closes the gap without the picture jumping: up to 15% faster
// or slower.
export const nudge = (behind: number) =>
  Math.abs(behind) < 0.012 ? 1 : 1 + Math.max(-0.15, Math.min(0.15, behind * 2));

const inPool = (unit: Unit, pool: Pool) =>
  unit.pool === pool || (unit.also?.includes(pool) ?? false);
const suits = (unit: Unit, want: Want) =>
  want === "talk" ? inPool(unit, "talk") || inPool(unit, "greet") : inPool(unit, want);
// Sitting quietly, whether idling or listening.
const quiet = (unit: Unit) => inPool(unit, "idle") || inPool(unit, "listen");

// Captions may contain Urdu script and English within the same sentence.
// Only map a few unambiguous cues to the more conspicuous gesture clips.
export function speechGesture(phrase: string): string {
  const normalized = phrase.toLowerCase().normalize("NFKC")
    .replace(/[\u0640\u064b-\u065f\u0670]/g, "")
    .replace(/ي/g, "ی").replace(/ك/g, "ک");
  const clauses = normalized.trim().split(/[.!؟?۔\n]+/).filter((part) => part.trim());
  const clause = clauses[clauses.length - 1] ?? "";
  const text = " " + clause.replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
  if (/^ (?:salaa?m|assalaa?m|assalamualaikum|hello|hi|ال?سلام|سلام|وعلیکم) /.test(text)) return "greet";
  if (/ (?:shukriya|shukria|شکریہ|thanks|thank you|sorry|معذرت|maazrat) /.test(text)) return "talk_chest";
  if (/ (?:pehl[aiye]|pehle|پہلے|پہلی|پہلا|دوسرا|دوسری|firstly|secondly|step one) /.test(text)) return "talk_count";
  if (/ (?:shayad|shaayad|شاید|پتا نہیں|پتہ نہیں|pata nahi|maybe|not sure) /.test(text)) return "talk_shrug";
  if (/[؟?]\s*$/.test(normalized) || /^ (?:kya|kaise|kyun|کیا|کیسے|کیوں|how|why) /.test(text)) return "talk_lean";
  return "";
}

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
  private lastCue = "";
  private lately: string[] = []; // the units chosen most recently

  // players: two video elements, one on top of the other. One shows the
  // current unit while the other has the next one ready.
  // show(front, soft): bring that player to the front, at once or through
  // a dissolve.
  constructor(
    private players: [HTMLVideoElement, HTMLVideoElement],
    private units: Unit[],
    private show: (front: number, soft: boolean) => void,
    private phrase: () => string = () => ""
  ) {}

  // A scripted shot can be prepared from any unit installed on the GPU,
  // even while the idle player's local copy is still downloading.
  get scriptedClip() {
    return this.units.find((unit) => unit.name === "talk_right")?.name ??
      this.units.find((unit) => unit.pool === "talk")?.name ?? this.units[0].name;
  }

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

  // Discard promises about frames for audio that the caller has interrupted.
  cancelSpeech() {
    this.claimed = 0;
    this.greet = false;
    this.turn("listen");
    this.greet = false;
  }

  // The unit and frame that will be on screen at time t, and how many
  // frames of that unit are left from there (that frame included).
  at(t: number): { unit: Unit; frame: number; left: number } {
    this.plan(t);
    const slot = this.slotAt(t);
    const frame = Math.max(
      slot.from,
      Math.min(slot.to - 1, slot.from + Math.floor((t - slot.start) * FPS + 1e-8))
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
    if (want !== "talk") this.lastCue = "";
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
    // On her way back to rest she is left alone: what suits her now follows.
    if (suits(current.unit, want) || current.wrap) return;
    // Between idling and listening nothing is cut short: both are her
    // sitting quietly, and what follows is chosen to suit.
    if ((want === "idle" || want === "listen") && quiet(current.unit)) return;

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
    if (!current.shown && frame - current.from < SHORTEST) {
      // It has not begun and would only flash by: leave it out altogether.
      this.slots = this.slots.filter((slot) => slot !== current);
      this.softNext = current.soft;
      if (unit.pool === "greet") this.greet = true;
      return;
    }

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
        wrap: true,
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
    while (this.end(last) <= until) {
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
    if (this.want === "talk" && this.greet && ready.some((unit) => unit.pool === "greet")) {
      this.greet = false;
      pool = "greet";
    }
    let choice = ready.filter((unit) => inPool(unit, pool));
    if (pool === "talk") {
      const cue = speechGesture(this.phrase());
      // One expressive movement is enough for a phrase. While she continues
      // explaining, open hands and small beats work without implying emotion.
      // A quiet first reply uses the take with a small head tilt and a
      // relaxed jaw. Save the broad, two-handed take for a longer line.
      let preferred = cue && cue !== this.lastCue ? ready.find((u) => u.name === cue) : undefined;
      if (!preferred && previous && quiet(previous)) {
        preferred = choice.find((unit) => unit.name === "talk_right");
      }
      this.lastCue = cue;
      if (preferred && preferred !== previous) {
        choice = [preferred];
      } else {
        const neutral = choice.filter((u) => ["talk_open", "talk_right", "talk_both"].includes(u.name));
        if (neutral.length) choice = neutral;
      }
    }
    if (!choice.length) choice = ready.filter((unit) => inPool(unit, "listen"));
    if (!choice.length) choice = ready;
    // Not a movement she has just made, when there are others.
    const keep = Math.min(3, Math.floor(choice.length / 2));
    const lately = keep ? this.lately.slice(-keep) : [];
    const fresh = choice.filter((unit) => !lately.includes(unit.name) && unit !== previous);
    if (fresh.length) choice = fresh;
    else if (choice.length > 1) choice = choice.filter((unit) => unit !== previous);
    // By weight.
    let at = Math.random() * choice.reduce((sum, unit) => sum + (unit.weight ?? 1), 0);
    let picked = choice[choice.length - 1];
    for (const unit of choice) {
      at -= unit.weight ?? 1;
      if (at < 0) {
        picked = unit;
        break;
      }
    }
    this.lately.push(picked.name);
    if (this.lately.length > 6) this.lately.shift();
    return picked;
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
      video.playbackRate = 1;
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
      const behind = want - video.currentTime;
      if (Math.abs(behind) > 0.12) {
        video.currentTime = want;
        video.playbackRate = 1;
      } else {
        video.playbackRate = nudge(behind);
      }
      if (video.paused) video.play().catch(() => {});
    }
  }

  // Stops a player that is no longer in front.
  private rest(video: HTMLVideoElement) {
    if (video !== this.players[this.front]) video.pause();
  }
}
