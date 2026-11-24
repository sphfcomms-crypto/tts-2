import { avatarBus, type Stage } from "./bus";
import type { CallGestures } from "./callGestures";
import { FPS, fromFilm, nudge, stageClock } from "./director";
import { FirstSample, holdFor, lipLead, PICTURE_LAG, SliceCutter, squareMask, Timeline, wav16, type Piece } from "./flashSlices";
import { Reel } from "./liveTalk";

// Her whole face, drawn new for every picture of a live call.
//
// The lip video (liveTalk.ts) redraws her mouth on clips that were filmed
// beforehand. Here a streaming video model on the GPU box
// (avatar-flash/server.py, SoulX-FlashHead) draws her head and shoulders
// from her voice alone, the way an offline model such as Seedance does:
// lips, teeth, jaw, cheeks, eyes, brows and the movement of her head all
// come from the sound. The box lays that square back into her still
// picture and sends whole frames.
//
//   - her voice is held back (a plain delay; the sound is not touched);
//   - meanwhile it is cut into slices of about a second, each sent to the
//     box as soon as it is complete, in order. The model continues her
//     movement from one slice to the next, so slices are sent all through
//     the call, in her silences too: then she sits, blinks and listens;
//   - each slice comes back as a short silent video. The pieces are joined
//     and a clock keeps the picture on the piece that belongs to the sound
//     being heard.
// When a piece is not there in time, or the box stops answering, the
// filmed clips underneath show instead, and the stream is started again.
// Her voice is played a little before the pictures' clock (PICTURE_LAG):
// the model's lips run that much ahead of its own sound.
//
// Her hands: the model draws only the square around her head, and the rest
// of its frame is a photograph. Where the filmed clips were made from that
// same photograph, the stream is shown only inside the square (fading out
// towards its edges) and the clips go on playing underneath it. The
// director is told of her lines as in the lip video, so her hands gesture
// while she talks and lie in her lap while she listens.

const DOWN = 3; // her voice is sent at a third of the device's rate (16 kHz)
const LOUD = 0.006; // RMS above this is her voice
const MIN_HOLD = 1.1;
const MAX_HOLD = 4;
const FADE = 180; // ms: the dissolve between the filmed clip and the stream
const QUIET = 0.5; // s of silence, as heard, that ends a line: her hands go back to her lap
const RETRY = [2000, 5000, 10000]; // ms before the stream is tried again
// The style properties of the mask that shows the stream only inside the square (see squareMask).
const MASK = ["mask-image", "mask-composite", "mask-size", "mask-repeat"];

export class FlashTalk {
  private context: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private source: AudioNode | null = null;
  private delay: DelayNode | null = null;
  private reel: Reel | null = null;
  private clock = 0;
  private stopped = false;

  private rate = 16000;
  private slice = 0.96; // seconds of voice per piece
  private look = 0; // seconds of sound the model hears beyond what it draws
  private cutter: SliceCutter | null = null;
  private first = new FirstSample(); // when the first sample was captured
  private lead = PICTURE_LAG; // seconds her voice is played before the pictures' clock
  // A server with a look of its own: nothing else draws her in it, so a
  // broken stream is tried again for the whole call instead of given up.
  private keepTrying = false;
  // The stream never worked: the caller takes over once her voice still
  // held back has been heard.
  private givingUp = false;
  private timeline = new Timeline();
  private order: Promise<void> = Promise.resolve();
  private requests = new AbortController();
  private sid = "";
  private run = 0; // slices of an abandoned run are ignored when they come back
  private hold: number;
  // For recent slices: seconds from their first sound being captured to
  // the moment their first picture could be shown.
  private took: number[] = [];
  private lastVoiceAt = -Infinity;
  private showing = false;
  private broken = false; // the stream is down; the filmed clips show
  private failures = 0;
  private retries = 0;
  private everShown = false;
  private count = { asked: 0, joined: 0, due: 0, shown: 0, late: 0 };
  private overClips = false; // the stream shows only her head, over the filmed clips
  private talking = false; // she is in a line: her body gestures
  private lines = 0;

  // onFail: the stream never produced a picture, or her stage was taken
  // down. The caller then has her another way; the voice held back until
  // then has been played.
  // gestures: what she is saying, for the kind of gesture that suits it.
  // greet: she speaks first in this call.
  constructor(
    private stage: Stage,
    private voice: MediaStream,
    private onFail: () => void,
    private gestures?: CallGestures,
    private greet = false
  ) {
    const flash = avatarBus.flash;
    if (flash) {
      this.slice = flash.sliceFrames / flash.fps;
      this.look = flash.lookFrames / flash.fps;
      this.keepTrying = Boolean(flash.ownLook);
    }
    this.lead = lipLead(window.location.search);
    // Before any slice has come back, go by what the server says one costs it,
    // plus the way there and back. Without this the first slices of a call
    // came late and the picture flickered between the clip and the stream.
    const work = flash?.workSeconds ?? 0;
    const expected = work > 0 ? [this.slice + this.look + work + 0.1] : [];
    this.hold = holdFor(expected, this.slice + this.look, MIN_HOLD, MAX_HOLD);
  }

  async start() {
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: 48000 });
    } catch {
      context = new AudioContext();
    }
    this.context = context;
    this.rate = context.sampleRate / DOWN;
    this.cutter = new SliceCutter(Math.round(this.slice * this.rate));
    await context.audioWorklet.addModule("/pcm-worklet.js");
    if (this.stopped) return;

    const source = context.createMediaStreamSource(this.voice);
    this.source = source;
    const delay = context.createDelay(MAX_HOLD + 1);
    delay.delayTime.value = this.voiceDelay();
    source.connect(delay).connect(context.destination);
    this.delay = delay;

    const capture = new AudioWorkletNode(context, "pcm-capture");
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => this.hear(new Int16Array(data));
    source.connect(capture);
    // A node with no live input stops being asked for sound, and her
    // silences must be drawn too.
    const hush = context.createConstantSource();
    hush.offset.value = 0;
    hush.connect(capture);
    hush.start();
    this.nodes = [delay, capture, hush];

    await this.open();
    if (this.stopped) return;
    this.stage.video.style.transition = `opacity ${FADE}ms linear`;
    this.stage.director.liveCall(true);
    this.layOverClips();
    this.clock = window.setInterval(() => this.tick(), 40);
    (window as unknown as { __flash?: FlashTalk }).__flash = this;
  }

  // Shows the stream only inside the square the model draws, over the
  // filmed clips, when every clip she can be in was made from the picture
  // the server draws her from. (A clip from any other picture has her
  // shoulders somewhere else: the whole frame is shown then, as before.)
  private layOverClips() {
    const flash = avatarBus.flash;
    const units = this.stage.director.units;
    if (!flash?.square || !flash.width || !flash.height || !units.length || !units.every(fromFilm)) return;
    const mask = squareMask(flash.square, flash.width, flash.height);
    const style = this.stage.video.style;
    for (const prefix of ["-webkit-", ""]) {
      style.setProperty(`${prefix}mask-image`, mask);
      style.setProperty(`${prefix}mask-composite`, prefix ? "source-in" : "intersect");
      style.setProperty(`${prefix}mask-size`, "100% 100%");
      style.setProperty(`${prefix}mask-repeat`, "no-repeat");
    }
    this.overClips = true;
    this.stage.director.overlaid = true;
  }

  // Her body. The director is told of a line when its first sound is
  // captured, which is `lag` before it is heard, so that a gesture starts
  // with her voice; and of what she is saying, for the kind of gesture.
  private body(context: AudioContext, captured: number, seconds: number, level: number, loud: boolean) {
    const director = this.stage.director;
    const seen = captured + this.lag(context) + (stageClock() - context.currentTime);
    this.gestures?.hear(captured, seconds, level, loud);
    if (loud && !this.talking) {
      this.talking = true;
      const cue = this.gestures?.cue(captured, true, this.greet && this.lines === 0);
      // Never a line with her hands still: an understated gesture when
      // nothing is known of the line yet.
      director.gesture(cue ?? { role: "reflect", clause: -1 - this.lines }, seen);
      this.lines += 1;
      director.turn("talk", seen);
      this.stage.talking(true);
    } else if (this.talking) {
      const cue = this.gestures?.cue(captured);
      if (cue) director.gesture(cue, seen);
    }
  }

  private async open() {
    this.reel?.close();
    const reel = new Reel(this.stage.video);
    this.reel = reel;
    this.order = reel.open();
    await this.order;
    this.sid = crypto.randomUUID().replace(/-/g, "");
    this.cutter?.restart();
  }

  // Still her voice in the delay, on its way to be heard.
  get hasSpeech() {
    const now = this.context?.currentTime;
    return now !== undefined && now <= this.lastVoiceAt + this.hold + 0.06;
  }

  // The caller has cut her off: what she had not yet been heard to say is
  // dropped, and its pictures with it. The filmed clip shows until the
  // sound from now on is due.
  interrupt() {
    const context = this.context;
    if (!context || !this.delay || !this.source || this.stopped || !this.hasSpeech) return;
    const old = this.delay;
    this.source.disconnect(old);
    old.disconnect();
    const delay = context.createDelay(MAX_HOLD + 1);
    delay.delayTime.value = this.voiceDelay();
    this.source.connect(delay).connect(context.destination);
    this.delay = delay;
    this.nodes = this.nodes.map((node) => (node === old ? delay : node));
    this.timeline.cut(context.currentTime);
    this.lastVoiceAt = -Infinity;
    // Her hands go back to her lap: she is being spoken to.
    this.talking = false;
    this.stage.director.cancelSpeech();
    this.stage.talking(false);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.requests.abort();
    window.clearInterval(this.clock);
    this.show(false);
    this.stage.director.liveCall(false);
    this.stage.director.overlaid = false;
    this.stage.talking(false);
    this.stage.video.style.transition = "";
    for (const name of MASK) {
      this.stage.video.style.removeProperty(name);
      this.stage.video.style.removeProperty(`-webkit-${name}`);
    }
    this.reel?.close();
    this.reel = null;
    for (const node of this.nodes) {
      try {
        this.source?.disconnect(node);
      } catch {}
      node.disconnect();
    }
    this.nodes = [];
    this.context?.close().catch(() => {});
    this.context = null;
  }

  // How it went, for the report the page sends and for the browser console
  // (window.__flash.describe()).
  describe() {
    const sorted = [...this.took].sort((x, y) => x - y);
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      renderer: "whole-face",
      hold: round(this.hold),
      lead: round(this.lead),
      keepTrying: this.keepTrying,
      slice: round(this.slice),
      pieceSecondsMedian: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]) : null,
      pieceSecondsMax: sorted.length ? round(sorted[sorted.length - 1]) : null,
      asked: this.count.asked,
      joined: this.count.joined,
      late: this.count.late,
      // Of the moments a picture was due, the share with the stream on screen.
      shownShare: this.count.due ? round(this.count.shown / this.count.due) : null,
      failures: this.failures,
      broken: this.broken,
      rate: this.context?.sampleRate ?? null,
      overClips: this.overClips,
    };
  }

  // How long her voice is held back: the pictures' hold, less the lead.
  private voiceDelay(hold = this.hold) {
    return Math.max(0, hold - this.lead);
  }

  // Seconds between a sound being captured here and its picture being due.
  private lag(context: AudioContext) {
    const stamp = context.getOutputTimestamp?.();
    if (stamp?.contextTime && stamp.performanceTime) {
      const elapsed = (performance.now() - stamp.performanceTime) / 1000;
      const latency = context.currentTime - (stamp.contextTime + elapsed);
      if (elapsed >= -0.02 && elapsed < 0.5 && latency >= -0.02 && latency < 0.5) {
        return this.hold + Math.max(0, latency);
      }
    }
    return this.hold + Math.min(context.outputLatency || context.baseLatency || 0, 0.05);
  }

  // A block of her voice from the capture worklet, at the device's rate.
  private hear(block: Int16Array) {
    const context = this.context;
    const cutter = this.cutter;
    if (this.stopped || !context || !cutter) return;
    const third = new Int16Array(Math.floor(block.length / DOWN));
    let sum = 0;
    for (let i = 0; i < third.length; i++) {
      const sample = Math.round((block[3 * i] + block[3 * i + 1] + block[3 * i + 2]) / 3);
      third[i] = sample;
      sum += (sample / 32768) ** 2;
    }
    this.first.hear(context.currentTime, block.length, context.sampleRate);
    const level = Math.sqrt(sum / Math.max(1, third.length));
    const seconds = block.length / context.sampleRate;
    if (level > LOUD) this.lastVoiceAt = context.currentTime;
    this.body(context, context.currentTime - seconds, seconds, level, level > LOUD);
    for (const slice of cutter.push(third)) {
      this.first.settle();
      if (this.broken) continue;
      this.send(slice.seq, slice.samples, this.first.at + slice.first / this.rate);
    }
  }

  // Sends one slice to be drawn. Answers are joined in the order sent.
  private send(seq: number, samples: Int16Array, spokenAt: number) {
    const reel = this.reel;
    const context = this.context;
    const flash = avatarBus.flash;
    if (!reel || !context || !flash) return this.breakStream();
    const run = this.run;
    // The pictures of a slice show the sound from `look` earlier.
    const piece: Piece = { audioStart: spokenAt - this.look, length: this.slice, mediaStart: -1 };
    this.timeline.add(piece);
    this.count.asked += 1;
    // A body with no type keeps the browser from asking the box for
    // permission before every slice.
    const answer = fetch(`${flash.url}/say?sid=${this.sid}&seq=${seq}&t=${flash.token}`, {
      method: "POST",
      body: new Blob([new Uint8Array(wav16(samples, this.rate))]),
      signal: AbortSignal.any([this.requests.signal, AbortSignal.timeout(8000)]),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`whole-face slice failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      })
      .catch(() => null);
    this.order = this.order
      .then(async () => {
        if (run !== this.run || this.stopped) return;
        const video = await answer;
        if (run !== this.run || this.stopped) return;
        if (!video) return this.breakStream();
        piece.mediaStart = await reel.append(video);
        this.count.joined += 1;
        const took = context.currentTime - spokenAt + this.look;
        if (took > this.lag(context)) this.count.late += 1;
        this.took.push(took);
        if (this.took.length > 30) this.took.shift();
      })
      .catch(() => {
        if (run === this.run) this.breakStream();
      });
  }

  // The stream is down. The filmed clips show; her voice goes on as it is.
  // It is started again a little later, a few times.
  private breakStream() {
    if (this.broken || this.stopped) return;
    this.broken = true;
    this.failures += 1;
    this.run += 1;
    this.requests.abort();
    this.requests = new AbortController();
    this.timeline = new Timeline();
    this.show(false);
    // With no head drawn over them, the clips in which her own mouth moves
    // are not shown as they are.
    this.stage.director.overlaid = false;
    if (!this.everShown && (!this.keepTrying || this.retries >= RETRY.length)) {
      // It never worked on this device or line: the caller has her another
      // way for this call, once what she is saying now has been heard
      // (stopping at once would drop the voice still held back). In a look
      // of the server's own it is first tried a few times more: the server
      // may only have been full for a moment.
      this.givingUp = true;
      return;
    }
    // In a look of the server's own she sits in its quiet loop meanwhile,
    // her voice goes on, and the stream is tried again every 10 s.
    const wait = RETRY[this.retries++] ?? (this.keepTrying ? RETRY[RETRY.length - 1] : undefined);
    if (wait === undefined) return;
    window.setTimeout(() => {
      if (this.stopped) return;
      this.open()
        .then(() => {
          this.broken = false;
          this.stage.director.overlaid = this.overClips;
        })
        .catch(() => {});
    }, wait);
  }

  // Keeps the picture on the piece that belongs to the sound being heard.
  private tick() {
    const context = this.context;
    if (this.stopped || !context) return;
    // Her stage was taken down under the call, or the stream never worked:
    // the caller plays her voice another way from here.
    if (avatarBus.stage?.video !== this.stage.video || (this.givingUp && !this.hasSpeech)) {
      this.stop();
      this.onFail();
      return;
    }
    const video = this.stage.video;
    const lag = this.lag(context);
    const spoken = context.currentTime - lag; // when what is heard now was captured
    const piece = this.broken ? undefined : this.timeline.at(spoken);

    if (this.timeline.size) this.count.due += 1;
    if (piece && piece.mediaStart >= 0) {
      const want = piece.mediaStart + (spoken - piece.audioStart);
      const behind = want - video.currentTime;
      const seek = Math.abs(behind) > 2 / FPS;
      if (seek && !video.seeking) {
        video.currentTime = want;
        video.playbackRate = 1;
      } else if (!seek && !video.seeking) {
        video.playbackRate = nudge(behind);
      }
      const ready = !seek && !video.seeking && !video.paused && video.readyState >= 2;
      if (video.paused) video.play().catch(() => {});
      this.show(ready);
      if (ready) {
        this.count.shown += 1;
        this.everShown = true;
        this.retries = 0;
      }
    } else {
      this.show(false);
      if (!video.paused) video.pause();
    }

    // Her line is over once its last sound has been heard.
    if (this.talking && context.currentTime > this.lastVoiceAt + this.hold + QUIET) {
      this.talking = false;
      this.stage.talking(false);
    }

    // In her silences, set the delay to what the slices really need. (Not
    // while she speaks: a change of delay is heard.)
    if (this.delay && this.took.length >= 2 && !this.hasSpeech) {
      const target = holdFor(this.took, this.slice + this.look, MIN_HOLD, MAX_HOLD);
      if (Math.abs(target - this.hold) > 0.12) {
        this.hold = target;
        this.delay.delayTime.value = this.voiceDelay(target);
      }
    }
  }

  private show(on: boolean) {
    if (this.showing === on) return;
    this.showing = on;
    this.stage.speaking(on);
  }
}
