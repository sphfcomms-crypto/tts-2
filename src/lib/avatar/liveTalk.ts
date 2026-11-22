import { avatarBus, Stage } from "./bus";
import { FPS, stageClock } from "./director";

// Her lips, drawn on her moving body, for any voice that plays: a live call
// or a script from the Play button.
//
//   - her voice is held back about a second before it is played (a plain
//     delay; the sound itself is not touched);
//   - meanwhile it is cut into 0.4 s chunks. For each chunk the director
//     says which clip, and which frames of it, will be on screen when the
//     chunk is heard. The GPU box draws her saying the chunk on exactly
//     those frames and returns a short silent video;
//   - the video pieces are joined, and a clock keeps the picture on the
//     piece that belongs to the sound being heard at that moment.
// Underneath, the same clips keep playing without the lips, so when she
// stops speaking nothing changes but her mouth. The director is told the
// moment she begins a line (about a second before it is heard), and cuts
// to a gesture that starts with her voice.
//
// If a piece is not back in time, the clip underneath shows for that
// moment (her mouth closed) rather than a picture that is out of step. The
// delay adjusts itself, between her lines, to how long the pieces really
// take. If the GPU stops answering, onFail is called once and the caller
// plays her voice directly.

const TYPE = 'video/mp4; codecs="avc1.4d401f"';
const CHUNK = 0.4; // seconds of voice per piece
const LEAD = 0.2; // earlier sound sent along as context for the mouth
const PRE_ROLL = 0.1; // sound kept from just before she is heard to start
const QUIET = 1.2; // silence that ends a line (shorter pauses are drawn)
const LOUD = 0.006; // RMS above this is her voice
const FIRST_DELAY = 1.5; // seconds her voice is held back, to begin with
const MIN_DELAY = 0.9;
const MAX_DELAY = 4;
const SHORT = 3; // pieces of fewer frames than this are not made

export function canShowVideo(): boolean {
  if (typeof window === "undefined") return false;
  const scope = window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource };
  const Source = scope.MediaSource ?? scope.ManagedMediaSource;
  return Boolean(Source && Source.isTypeSupported(TYPE));
}

type Segment = {
  audioStart: number; // when this piece was spoken, on the audio clock
  length: number; // seconds
  mediaStart: number; // where its video sits in the joined video; -1 until it is in
};

// One drawn piece, as it was asked for and where it ended up: enough to
// check afterwards, picture by picture, that her lips were in step.
export type Trace = Segment & {
  lag: number; // seconds between the sound being captured and being heard
  clip: string; // the body-language clip it was drawn on
  frame: number; // and the first frame of that clip
};

// Where her voice comes from: a call's audio stream, or a node of the
// audio graph the Play button builds (which then must not be connected to
// the speakers itself).
export type Voice =
  | { stream: MediaStream }
  | { context: AudioContext; node: AudioNode };

const tail = (samples: Int16Array, count: number) =>
  samples.length > count ? samples.slice(samples.length - count) : samples;

function join(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function wav(pcm: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(out.buffer, 44).set(pcm);
  return out;
}

// The capture code is added to an audio context once.
const withCapture = new WeakSet<AudioContext>();

// Silent video pieces joined end to end. Nothing plays by itself: the
// caller moves the picture.
class Reel {
  private buffer: SourceBuffer | null = null;
  private url = "";
  private end = 0;

  constructor(private video: HTMLVideoElement) {}

  open(): Promise<void> {
    return new Promise<void>((ready, failed) => {
      const scope = window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource };
      const Source = scope.MediaSource ?? scope.ManagedMediaSource;
      if (!Source || !Source.isTypeSupported(TYPE)) {
        return failed(new Error("this browser cannot join the video"));
      }
      const source = new Source();
      this.url = URL.createObjectURL(source);
      this.video.muted = true;
      this.video.src = this.url;
      source.addEventListener(
        "sourceopen",
        () => {
          try {
            this.buffer = source.addSourceBuffer(TYPE);
            ready();
          } catch (err) {
            failed(err);
          }
        },
        { once: true }
      );
    });
  }

  private settled() {
    const buffer = this.buffer!;
    return new Promise<void>((done, broke) => {
      buffer.addEventListener("updateend", () => done(), { once: true });
      buffer.addEventListener("error", () => broke(new Error("a video piece was rejected")), { once: true });
    });
  }

  // Joins the piece on and says where in the reel it starts.
  async append(piece: Uint8Array): Promise<number> {
    const buffer = this.buffer;
    if (!buffer) throw new Error("the reel is closed");
    // On a long call, what was shown a while ago is let go.
    const now = this.video.currentTime;
    if (now > 60 && buffer.buffered.length && buffer.buffered.start(0) < now - 40) {
      buffer.remove(0, now - 20);
      await this.settled();
    }
    const start = this.end;
    buffer.timestampOffset = start;
    buffer.appendBuffer(new Uint8Array(piece));
    await this.settled();
    const ranges = buffer.buffered;
    this.end = ranges.length ? ranges.end(ranges.length - 1) : start;
    return start;
  }

  close() {
    this.buffer = null;
    const video = this.video;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

export class LiveTalk {
  private context: AudioContext | null = null;
  private ownsContext = false;
  private nodes: AudioNode[] = [];
  private source: AudioNode | null = null;
  private delay: DelayNode | null = null;
  private reel: Reel | null = null;
  private clock = 0;
  private stopped = false;
  private failed = false;

  private rate = 24000; // of the voice kept here: half the device's rate
  private firstAt = -1; // audio-clock time of the first sample heard
  private heard = 0; // samples heard so far
  private recent: Int16Array = new Int16Array(0); // the latest sound, for lead and pre-roll
  private pending: Int16Array = new Int16Array(0); // her line so far, not yet sent
  private pendingAt = 0; // sample number where `pending` starts
  private talking = false; // she is in the middle of a line
  private drawing = false; // her voice is being sent to be drawn
  private quiet = 0; // samples of silence in a row
  private lines = 0; // lines she has begun
  // For the report: how the drawing kept up with her voice.
  private count = { asked: 0, joined: 0, due: 0, shown: 0 };

  private segments: Segment[] = [];
  private order: Promise<void> = Promise.resolve();
  private hold = FIRST_DELAY;
  private needed: number[] = []; // how long recent pieces took to be ready
  private showing = false;
  private missingSince = 0;
  private history: Trace[] = [];
  private directFailed = false; // the box could not be reached from here

  // greet: her first line is a hello (a call); she waves with it.
  constructor(
    private stage: Stage,
    private voice: Voice,
    private onFail: () => void,
    private greet = false
  ) {}

  async start() {
    let context: AudioContext;
    let source: AudioNode;
    if ("stream" in this.voice) {
      context = new AudioContext();
      this.ownsContext = true;
      source = context.createMediaStreamSource(this.voice.stream);
    } else {
      context = this.voice.context;
      source = this.voice.node;
    }
    this.context = context;
    this.source = source;
    this.rate = context.sampleRate / 2;
    if (!withCapture.has(context)) {
      await context.audioWorklet.addModule("/pcm-worklet.js");
      withCapture.add(context);
    }
    if (this.stopped) return;

    const reel = new Reel(this.stage.video);
    this.reel = reel;
    this.order = reel.open();
    this.order.catch(() => this.fail());

    // Her voice, played late by `hold` seconds.
    const delay = context.createDelay(MAX_DELAY + 1);
    delay.delayTime.value = this.hold;
    source.connect(delay).connect(context.destination);
    this.delay = delay;

    const capture = new AudioWorkletNode(context, "pcm-capture");
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) =>
      this.hear(new Int16Array(data));
    source.connect(capture);
    // Kept running through silence too (a node with no live input stops
    // being asked for sound): a clip in which her mouth moves must go on
    // being redrawn after her voice has ended.
    const hush = context.createConstantSource();
    hush.offset.value = 0;
    hush.connect(capture);
    hush.start();
    this.nodes = [delay, capture, hush];

    this.clock = window.setInterval(() => this.tick(), 40);
    (window as unknown as { __talk?: LiveTalk }).__talk = this;
    // A first, silent piece: it wakes the route to the GPU and shows how
    // long a piece takes before she has said anything.
    this.probe();
  }

  // How long after her voice has all been handed over she is still
  // speaking (the held-back sound playing out), in milliseconds.
  get tail() {
    return (this.hold + 0.5) * 1000;
  }

  // Still drawing, or still showing what was drawn.
  get busy() {
    return this.drawing || this.showing;
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.clock);
    this.reel?.close();
    this.reel = null;
    this.show(false);
    this.stage.talking(false);
    for (const node of this.nodes) {
      try {
        this.source?.disconnect(node);
      } catch {}
      node.disconnect();
    }
    this.nodes = [];
    if (this.ownsContext) this.context?.close().catch(() => {});
    this.context = null;
  }

  // Every piece drawn so far (the last few hundred), for checking from the
  // browser console (window.__talk.timeline()) or by a recording.
  timeline() {
    return { hold: this.hold, pieces: this.history };
  }

  // How it went, for the report the page sends when she has finished and
  // for checking from the browser console.
  describe() {
    const sorted = [...this.needed].sort((x, y) => x - y);
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      hold: round(this.hold),
      pieceSecondsMedian: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]) : null,
      pieceSecondsMax: sorted.length ? round(sorted[sorted.length - 1]) : null,
      asked: this.count.asked,
      joined: this.count.joined,
      // Of the moments her voice was heard, the share with her lips drawn.
      lipsShare: this.count.due ? round(this.count.shown / this.count.due) : null,
      lines: this.lines,
      outputLatency: round(this.context?.outputLatency || this.context?.baseLatency || 0),
      rate: this.context?.sampleRate ?? null,
      failed: this.failed,
      direct: Boolean(avatarBus.direct) && !this.directFailed,
      talking: this.talking,
      showing: this.showing,
    };
  }

  private async request(audio: Int16Array, leadSamples: number, clip: string, start: number) {
    const leadMs = Math.round((leadSamples / this.rate) * 1000);
    // Straight to the GPU box when the browser can reach it: the way
    // through the app is slower. A body with no type keeps the browser
    // from asking the box for permission before every chunk.
    const direct = this.directFailed ? null : avatarBus.direct;
    if (direct) {
      try {
        const res = await fetch(
          `${direct.url}/speak?clip=${clip}&start=${start}&lead_ms=${leadMs}&audio=0&t=${direct.token}`,
          { method: "POST", body: new Blob([new Uint8Array(wav(audio, this.rate))]) }
        );
        if (!res.ok) throw new Error(`video chunk failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        this.directFailed = true;
      }
    }
    const res = await fetch(`/api/avatar/chunk?clip=${clip}&start=${start}&lead=${leadMs}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav(audio, this.rate)),
    });
    if (!res.ok) throw new Error(`video chunk failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private probe() {
    const began = performance.now();
    const silence = new Int16Array(Math.round(CHUNK * this.rate));
    const spot = this.stage.director.at(stageClock());
    this.request(silence, 0, spot.unit.name, 0)
      .then(() => {
        this.needed.push(CHUNK + (performance.now() - began) / 1000);
        this.adapt();
      })
      .catch(() => this.fail());
  }

  // A block of her voice from the capture worklet, at the device's rate.
  private hear(block: Int16Array) {
    const context = this.context;
    if (this.stopped || this.failed || !context) return;

    // Half the rate is plenty for the mouth, and half the upload.
    const half = new Int16Array(block.length >> 1);
    let sum = 0;
    for (let i = 0; i < half.length; i++) {
      const sample = (block[2 * i] + block[2 * i + 1]) >> 1;
      half[i] = sample;
      sum += (sample / 32768) ** 2;
    }
    if (this.firstAt < 0) {
      this.firstAt = context.currentTime - block.length / context.sampleRate;
    }
    const at = this.heard;
    this.heard += half.length;
    const loud = Math.sqrt(sum / half.length) > LOUD;
    // When this block will be heard (and its picture seen), on the
    // director's clock.
    const lag = this.hold + (context.outputLatency || context.baseLatency || 0);
    const seen = this.firstAt + at / this.rate + lag + (stageClock() - context.currentTime);

    // Is she in the middle of a line? (Her body gestures while she is.)
    if (loud) {
      if (!this.talking) {
        this.talking = true;
        if (this.greet && this.lines === 0) this.stage.director.greet = true;
        this.lines += 1;
        // The director is told now, about a second before she is heard,
        // so that a gesture begins with her voice and not seconds later.
        this.stage.director.turn("talk", seen);
        this.stage.talking(true);
      }
      this.quiet = 0;
    } else if (this.talking) {
      this.quiet += half.length;
      if (this.quiet >= QUIET * this.rate) {
        this.talking = false;
        this.stage.talking(false);
      }
    }

    // In some gesture clips her own mouth moves. Such a clip is redrawn for
    // as long as it is on screen, sound or no sound, so that she is never
    // seen mouthing words nobody hears.
    const cover = this.stage.director.at(seen).unit.mouths === true;
    const active = this.talking || cover;

    if (!this.drawing) {
      if (!active) {
        this.recent = tail(join(this.recent, half), Math.round((LEAD + PRE_ROLL) * this.rate));
        return;
      }
      // Drawing begins. The sound just before holds the very start of her
      // first word.
      const before = Math.min(this.recent.length, Math.round(PRE_ROLL * this.rate));
      this.pending = join(this.recent.slice(this.recent.length - before), half);
      this.pendingAt = at - before;
      this.recent = this.recent.slice(0, this.recent.length - before);
      this.drawing = true;
    } else {
      this.pending = join(this.pending, half);
    }

    const size = Math.round(CHUNK * this.rate);
    while (this.pending.length >= size) this.send(size);
    if (!active) {
      if (this.pending.length) this.send(this.pending.length);
      this.drawing = false;
    }
  }

  // Sends the first `count` samples of her line to be drawn, on the frames
  // of the clip that will be showing when they are heard. A chunk that
  // runs over the end of a clip is drawn in two pieces, one on each clip.
  // Answers may come back in any order; they are joined in the order sent.
  private send(count: number) {
    const reel = this.reel;
    const context = this.context;
    if (!reel || !context) return;
    const chunk = this.pending.slice(0, count);
    const lead = tail(this.recent, Math.round(LEAD * this.rate));
    const sound = join(lead, chunk); // the chunk with the sound before it
    this.pending = this.pending.slice(count);
    this.recent = tail(join(this.recent, chunk), Math.round((LEAD + PRE_ROLL) * this.rate));

    const audioStart = this.firstAt + this.pendingAt / this.rate;
    this.pendingAt += count;

    // When this chunk will be seen, on the director's clock.
    const lag = this.hold + (context.outputLatency || context.baseLatency || 0);
    let seen = audioStart + lag + (stageClock() - context.currentTime);
    let frames = Math.ceil((count / this.rate) * FPS - 0.001);
    let taken = 0; // samples of the chunk already given to a piece

    while (frames > 0) {
      let spot = this.stage.director.at(seen);
      if (spot.left < frames && spot.left < SHORT) {
        // Hardly anything of this clip is left: begin on the next one.
        seen += spot.left / FPS;
        spot = this.stage.director.at(seen);
      }
      let take = Math.min(frames, spot.left);
      // A remainder too short for a piece of its own stays with this one.
      if (frames - take > 0 && frames - take < SHORT) take = frames;
      const last = take === frames;
      const samples = last ? count - taken : Math.round((take / FPS) * this.rate);
      const from = lead.length + taken;
      const context0 = Math.max(0, from - lead.length);
      this.piece(
        reel,
        context,
        sound.slice(context0, from + samples),
        from - context0,
        { audioStart: audioStart + taken / this.rate, length: samples / this.rate, mediaStart: -1 },
        spot.unit.name,
        spot.frame,
        lag
      );
      taken += samples;
      frames -= take;
      seen += take / FPS;
      // What her lips are drawn on must now be shown as planned.
      this.stage.director.claim(seen);
    }
  }

  private piece(
    reel: Reel,
    context: AudioContext,
    audio: Int16Array,
    leadSamples: number,
    segment: Segment,
    clip: string,
    start: number,
    lag: number
  ) {
    this.segments.push(segment);
    this.count.asked += 1;
    const answer = this.request(audio, leadSamples, clip, start);
    // Without this a failed answer would be reported as unhandled before
    // its turn in the order comes.
    answer.catch(() => {});
    this.order = this.order
      .then(() => answer)
      .then((video) => reel.append(video))
      .then((mediaStart) => {
        segment.mediaStart = mediaStart;
        this.count.joined += 1;
        this.history.push({ ...segment, lag, clip, frame: start });
        if (this.history.length > 600) this.history.shift();
        this.needed.push(context.currentTime - segment.audioStart);
        if (this.needed.length > 30) this.needed.shift();
      })
      .catch(() => this.fail());
  }

  // Keeps the picture on the piece that belongs to the sound being heard.
  private tick() {
    const context = this.context;
    if (this.stopped || this.failed || !context) return;
    const video = this.stage.video;
    const lag = this.hold + (context.outputLatency || context.baseLatency || 0);
    const now = context.currentTime - lag; // when what is heard now was spoken

    while (this.segments.length && this.segments[0].audioStart + this.segments[0].length < now - 2) {
      this.segments.shift();
    }
    const segment = this.segments.find(
      (s) => s.audioStart <= now && now < s.audioStart + s.length
    );

    if (segment) {
      this.count.due += 1;
      if (segment.mediaStart >= 0) this.count.shown += 1;
    }
    if (segment && segment.mediaStart >= 0) {
      const want = segment.mediaStart + (now - segment.audioStart);
      if (video.paused || Math.abs(video.currentTime - want) > 0.12) {
        video.currentTime = want;
      }
      if (video.paused) video.play().catch(() => {});
      this.missingSince = 0;
      this.show(true);
    } else {
      // Nothing to show for this moment: she is silent, or the piece is
      // late. A very short miss is ridden out on the last picture.
      if (!this.missingSince) this.missingSince = performance.now();
      if (performance.now() - this.missingSince > 120) {
        if (!video.paused) video.pause();
        this.show(false);
      }
    }

    // Between her lines, set the delay to what the pieces really need.
    const idle = !this.drawing && !this.segments.some((s) => s.audioStart + s.length > now);
    if (idle) this.adapt();
  }

  // Sets how long her voice is held back: enough for most pieces to be
  // back in time; the odd slow one shows her mouth closed for a moment.
  // Only called while nothing is being heard, so the change is not heard.
  private adapt() {
    if (!this.delay || !this.needed.length || this.drawing) return;
    const sorted = [...this.needed].sort((x, y) => x - y);
    const usual = sorted[Math.floor((sorted.length - 1) * 0.85)];
    const target = Math.min(MAX_DELAY, Math.max(MIN_DELAY, usual + 0.15));
    if (Math.abs(target - this.hold) > 0.12) {
      this.hold = target;
      this.delay.delayTime.value = target;
    }
  }

  private show(on: boolean) {
    if (this.showing === on) return;
    this.showing = on;
    this.stage.speaking(on);
  }

  private fail() {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.stop();
    this.onFail();
  }
}

// Waits until she has finished the gesture she is in the middle of (a clip
// in which her mouth moves is drawn to its end), a few seconds at most.
export async function settled(face: LiveTalk) {
  const until = performance.now() + 7000;
  while (face.busy && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// Tells the app's server how the lip sync kept up on this device: numbers
// only (how many pieces, how late, how much of her speech had lips). It is
// written to the server's log, so a device on which she does not work can
// be understood without anyone having to describe what they saw.
export function report(kind: string, face: LiveTalk) {
  send({ kind, ...face.describe() });
}

export function send(facts: Record<string, unknown>) {
  try {
    navigator.sendBeacon(
      "/api/avatar/report",
      new Blob([JSON.stringify(facts)], { type: "application/json" })
    );
  } catch {}
}
