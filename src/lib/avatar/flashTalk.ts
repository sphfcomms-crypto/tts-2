import { avatarBus, type Stage } from "./bus";
import { FPS, nudge } from "./director";
import { holdFor, SliceCutter, Timeline, wav16, type Piece } from "./flashSlices";
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

const DOWN = 3; // her voice is sent at a third of the device's rate (16 kHz)
const LOUD = 0.006; // RMS above this is her voice
const MIN_HOLD = 1.1;
const MAX_HOLD = 4;
const FADE = 180; // ms: the dissolve between the filmed clip and the stream
const RETRY = [2000, 5000, 10000]; // ms before the stream is tried again

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
  private firstAt = -1; // audio-clock time of the first sample heard
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

  // onFail: the stream never produced a picture. The caller then draws her
  // the older way; her voice has not been touched.
  constructor(
    private stage: Stage,
    private voice: MediaStream,
    private onFail: () => void
  ) {
    const flash = avatarBus.flash;
    if (flash) {
      this.slice = flash.sliceFrames / flash.fps;
      this.look = flash.lookFrames / flash.fps;
    }
    this.hold = holdFor([], this.slice + this.look, MIN_HOLD, MAX_HOLD);
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
    delay.delayTime.value = this.hold;
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
    this.clock = window.setInterval(() => this.tick(), 40);
    (window as unknown as { __flash?: FlashTalk }).__flash = this;
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
    delay.delayTime.value = this.hold;
    this.source.connect(delay).connect(context.destination);
    this.delay = delay;
    this.nodes = this.nodes.map((node) => (node === old ? delay : node));
    this.timeline.cut(context.currentTime);
    this.lastVoiceAt = -Infinity;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.requests.abort();
    window.clearInterval(this.clock);
    this.show(false);
    this.stage.video.style.transition = "";
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
    };
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
    if (this.firstAt < 0) this.firstAt = context.currentTime - block.length / context.sampleRate;
    if (Math.sqrt(sum / Math.max(1, third.length)) > LOUD) this.lastVoiceAt = context.currentTime;
    for (const slice of cutter.push(third)) {
      if (this.broken) continue;
      this.send(slice.seq, slice.samples, this.firstAt + slice.first / this.rate);
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
    if (!this.everShown) {
      // It never worked on this device or line: let the caller draw her
      // the older way for this call.
      this.stop();
      this.onFail();
      return;
    }
    const wait = RETRY[this.retries++];
    if (wait === undefined) return;
    window.setTimeout(() => {
      if (this.stopped) return;
      this.open()
        .then(() => {
          this.broken = false;
        })
        .catch(() => {});
    }, wait);
  }

  // Keeps the picture on the piece that belongs to the sound being heard.
  private tick() {
    const context = this.context;
    if (this.stopped || !context) return;
    if (avatarBus.stage?.video !== this.stage.video) return this.stop();
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

    // In her silences, set the delay to what the slices really need. (Not
    // while she speaks: a change of delay is heard.)
    if (this.delay && this.took.length >= 2 && !this.hasSpeech) {
      const target = holdFor(this.took, this.slice + this.look, MIN_HOLD, MAX_HOLD);
      if (Math.abs(target - this.hold) > 0.12) {
        this.hold = target;
        this.delay.delayTime.value = target;
      }
    }
  }

  private show(on: boolean) {
    if (this.showing === on) return;
    this.showing = on;
    this.stage.speaking(on);
  }
}
