import { avatarBus, Stage } from "./bus";

// Her on video during a live call.
//
// In a call her voice arrives in real time, straight from the model. To
// show her lips moving with it:
//   - her voice is held back a little over a second before it is played
//     (a plain delay; the sound itself is not touched);
//   - meanwhile it is cut into 0.4 s chunks, each chunk goes to the GPU box
//     (through /api/avatar/chunk) and comes back as a short silent video
//     of her saying it;
//   - the video pieces are joined, and a clock keeps the picture on the
//     piece that belongs to the sound being heard at that moment.
// Between her lines no video is made and the idle picture shows.
//
// If a piece is not back in time, she is shown idle for that moment rather
// than out of step. The delay adjusts itself, between her lines, to how
// long the pieces really take. If the GPU stops answering, onFail is called
// once and the caller goes back to her direct voice.

const TYPE = 'video/mp4; codecs="avc1.4d401f"';
const CHUNK = 0.4; // seconds of voice per piece
const LEAD = 0.2; // earlier sound sent along as context for the mouth
const PRE_ROLL = 0.1; // sound kept from just before she is heard to start
const QUIET = 1.2; // silence that ends a line (shorter pauses are drawn)
const LOUD = 0.006; // RMS above this is her voice
const FIRST_DELAY = 1.5; // seconds her voice is held back, to begin with
const MIN_DELAY = 0.9;
const MAX_DELAY = 3;

type Segment = {
  audioStart: number; // when this chunk was spoken, on the audio clock
  length: number; // seconds
  mediaStart: number; // where its video sits in the joined video; -1 until it is in
};

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
  private talking = false;
  private quiet = 0; // samples of silence in a row

  private frame = 0; // where in her movement the next piece starts
  private segments: Segment[] = [];
  private order: Promise<void> = Promise.resolve();
  private hold = FIRST_DELAY;
  private needed: number[] = []; // how long recent pieces took to be ready
  private showing = false;
  private missingSince = 0;
  private directFailed = false; // the box could not be reached from here

  constructor(
    private stage: Stage,
    private voice: MediaStream,
    private onFail: () => void
  ) {}

  async start() {
    const context = new AudioContext();
    this.context = context;
    this.rate = context.sampleRate / 2;
    await context.audioWorklet.addModule("/pcm-worklet.js");
    if (this.stopped) return;

    const reel = new Reel(this.stage.video);
    this.reel = reel;
    this.order = reel.open();
    this.order.catch(() => this.fail());

    const source = context.createMediaStreamSource(this.voice);
    // Her voice, played late by `hold` seconds.
    const delay = context.createDelay(MAX_DELAY + 1);
    delay.delayTime.value = this.hold;
    source.connect(delay).connect(context.destination);
    this.delay = delay;

    const capture = new AudioWorkletNode(context, "pcm-capture");
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) =>
      this.hear(new Int16Array(data));
    source.connect(capture);

    this.clock = window.setInterval(() => this.tick(), 40);
    // A first, silent piece: it wakes the route to the GPU and shows how
    // long a piece takes before she has said anything.
    this.probe();
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.clock);
    this.reel?.close();
    this.reel = null;
    this.show(false);
    this.context?.close().catch(() => {});
    this.context = null;
  }

  // For checking a call from the browser console.
  describe() {
    return {
      hold: this.hold,
      needed: this.needed.map((n) => Math.round(n * 100) / 100),
      segments: this.segments.length,
      frame: this.frame,
      talking: this.talking,
      showing: this.showing,
      failed: this.failed,
      direct: Boolean(avatarBus.direct) && !this.directFailed,
    };
  }

  private async request(chunk: Int16Array, lead: Int16Array, start: number) {
    const leadMs = Math.round((lead.length / this.rate) * 1000);
    // Straight to the GPU box when the browser can reach it: the way
    // through the app is slower. A body with no type keeps the browser
    // from asking the box for permission before every chunk.
    const direct = this.directFailed ? null : avatarBus.direct;
    if (direct) {
      try {
        const res = await fetch(
          `${direct.url}/speak?clip=talk&start=${start}&lead_ms=${leadMs}&audio=0&t=${direct.token}`,
          { method: "POST", body: new Blob([new Uint8Array(wav(join(lead, chunk), this.rate))]) }
        );
        if (!res.ok) throw new Error(`video chunk failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        this.directFailed = true;
      }
    }
    const res = await fetch(`/api/avatar/chunk?start=${start}&lead=${leadMs}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav(join(lead, chunk), this.rate)),
    });
    if (!res.ok) throw new Error(`video chunk failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private probe() {
    const began = performance.now();
    const silence = new Int16Array(Math.round(CHUNK * this.rate));
    this.request(silence, new Int16Array(0), 0)
      .then(() => this.needed.push(CHUNK + (performance.now() - began) / 1000))
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

    if (!this.talking) {
      if (!loud) {
        this.recent = tail(join(this.recent, half), Math.round((LEAD + PRE_ROLL) * this.rate));
        return;
      }
      // She starts a line. The sound just before holds the very start of
      // her first word.
      const before = Math.min(this.recent.length, Math.round(PRE_ROLL * this.rate));
      this.pending = join(this.recent.slice(this.recent.length - before), half);
      this.pendingAt = at - before;
      this.recent = this.recent.slice(0, this.recent.length - before);
      this.talking = true;
      this.quiet = 0;
    } else {
      this.pending = join(this.pending, half);
      this.quiet = loud ? 0 : this.quiet + half.length;
    }

    const size = Math.round(CHUNK * this.rate);
    while (this.pending.length >= size) this.send(size);
    if (this.quiet >= QUIET * this.rate) {
      if (this.pending.length) this.send(this.pending.length);
      this.talking = false;
    }
  }

  // Sends the first `count` samples of her line to be drawn. Answers may
  // come back in any order; they are joined in the order they were sent.
  private send(count: number) {
    const reel = this.reel;
    const context = this.context;
    if (!reel || !context) return;
    const chunk = this.pending.slice(0, count);
    const lead = tail(this.recent, Math.round(LEAD * this.rate));
    this.pending = this.pending.slice(count);
    this.recent = tail(join(this.recent, chunk), Math.round((LEAD + PRE_ROLL) * this.rate));

    const segment: Segment = {
      audioStart: this.firstAt + this.pendingAt / this.rate,
      length: count / this.rate,
      mediaStart: -1,
    };
    this.pendingAt += count;
    this.segments.push(segment);

    const start = this.frame;
    this.frame += Math.ceil(segment.length * 25 - 0.001);

    const answer = this.request(chunk, lead, start);
    // Without this a failed answer would be reported as unhandled before
    // its turn in the order comes.
    answer.catch(() => {});

    this.order = this.order
      .then(() => answer)
      .then((piece) => reel.append(piece))
      .then((mediaStart) => {
        segment.mediaStart = mediaStart;
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
    const idle = !this.talking && !this.segments.some((s) => s.audioStart + s.length > now);
    if (idle && this.delay && this.needed.length >= 2) {
      // Enough for most pieces; the odd slow one shows her idle for a moment.
      const sorted = [...this.needed].sort((x, y) => x - y);
      const usual = sorted[Math.floor((sorted.length - 1) * 0.85)];
      const target = Math.min(MAX_DELAY, Math.max(MIN_DELAY, usual + 0.12));
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

  private fail() {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.stop();
    this.onFail();
  }
}
