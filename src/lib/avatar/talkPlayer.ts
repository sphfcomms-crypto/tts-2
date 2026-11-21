// Plays her speaking on video, piece by piece.
//
// The GPU box returns short MP4 pieces with her voice inside. They are
// joined here into one continuous video (Media Source Extensions), so the
// sound and her lips stay together by construction and each piece starts
// exactly where the last one ended.
//
//   PieceVideo  the joiner: open, append pieces, finish
//   TalkPlayer  a whole script from /api/avatar/speak (the Play button)
//
// A live call works differently (liveTalk.ts): there her voice is played
// on its own and the video pieces are silent.

import { avatarBus } from "./bus";

const TYPE = 'video/mp4; codecs="avc1.4d401f,mp4a.40.2"';
const STALL_MS = 160; // a pause shorter than this is not reported

type Sources = typeof MediaSource;
const mediaSource = (): Sources | null => {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as { MediaSource?: Sources; ManagedMediaSource?: Sources };
  const found = scope.MediaSource ?? scope.ManagedMediaSource ?? null;
  return found && found.isTypeSupported(TYPE) ? found : null;
};

export const canPlayTalk = () => mediaSource() !== null;

export class PieceVideo {
  // First picture and sound are out.
  onplay?: () => void;
  // Everything that was appended has been played (after finish()).
  onended?: () => void;
  // The video ran out before the next piece arrived (true), or picked up
  // again (false). The caller shows her idle meanwhile, so she is seen
  // pausing instead of frozen mid-word.
  onstall?: (stalled: boolean) => void;

  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private url = "";
  private queue: Promise<void> = Promise.resolve();
  private appended = 0;
  private playing = false;
  private stopped = false;
  private stallTimer = 0;

  constructor(private video: HTMLVideoElement) {}

  get isPlaying() {
    return this.playing;
  }

  // Resolves when pieces can be appended.
  open(): Promise<void> {
    return new Promise<void>((ready, failed) => {
      const Source = mediaSource();
      if (!Source) return failed(new Error("this browser cannot join the video"));
      const source = new Source();
      this.source = source;
      const video = this.video;
      this.url = URL.createObjectURL(source);
      video.src = this.url;
      video.muted = false;

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

      video.onended = () => {
        if (this.stopped) return;
        this.release();
        this.onended?.();
      };
      const report = (stalled: boolean) => {
        window.clearTimeout(this.stallTimer);
        if (!this.playing || this.stopped) return;
        if (!stalled) return this.onstall?.(false);
        this.stallTimer = window.setTimeout(() => this.onstall?.(true), STALL_MS);
      };
      video.onwaiting = () => report(true);
      video.onplaying = () => report(false);
    });
  }

  // Adds the next piece. Pieces are joined in the order of the calls.
  append(piece: Uint8Array): Promise<void> {
    const job = this.queue.then(() => this.place(piece));
    this.queue = job.catch(() => {});
    return job;
  }

  // No more pieces: what is there plays out, then onended is called.
  finish() {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (!this.appended) {
        this.release();
        this.onended?.();
        return;
      }
      await this.begin();
      try {
        if (this.source?.readyState === "open") this.source.endOfStream();
      } catch {}
    });
  }

  // Stops her mid-sentence. onended is not called.
  stop() {
    if (!this.stopped) this.release();
  }

  private settled() {
    const buffer = this.buffer!;
    return new Promise<void>((done, broke) => {
      buffer.addEventListener("updateend", () => done(), { once: true });
      buffer.addEventListener("error", () => broke(new Error("a video piece was rejected")), { once: true });
    });
  }

  private lastRange() {
    const ranges = this.buffer!.buffered;
    const last = ranges.length - 1;
    return last < 0 ? null : { start: ranges.start(last), end: ranges.end(last), count: ranges.length };
  }

  private async place(piece: Uint8Array) {
    const buffer = this.buffer;
    if (this.stopped || !buffer) return;
    // Each piece counts its own time from zero: it is placed right after
    // everything that is already there.
    const before = this.lastRange()?.end ?? 0;
    buffer.timestampOffset = before;
    buffer.appendBuffer(new Uint8Array(piece));
    await this.settled();
    // A piece whose first picture is not at its time zero leaves a small
    // hole in front of it, and playback would stop at the hole. Put the
    // piece back that much earlier.
    const placed = this.lastRange();
    const hole = placed ? placed.start - before : 0;
    if (placed && placed.count > 1 && hole > 0.002 && hole < 1) {
      buffer.remove(placed.start, placed.end);
      await this.settled();
      buffer.timestampOffset = before - hole;
      buffer.appendBuffer(new Uint8Array(piece));
      await this.settled();
    }
    this.appended += 1;
    await this.begin();
  }

  private async begin() {
    if (this.stopped) return;
    if (this.video.paused) await this.video.play();
    if (this.playing) return;
    this.playing = true;
    this.onplay?.();
  }

  private release() {
    this.stopped = true;
    window.clearTimeout(this.stallTimer);
    const video = this.video;
    video.onended = video.onwaiting = video.onplaying = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

export class TalkPlayer {
  onplay?: () => void;
  onended?: () => void;
  onstall?: (stalled: boolean) => void;

  private abort = new AbortController();
  private pieces: PieceVideo;

  constructor(video: HTMLVideoElement) {
    this.pieces = new PieceVideo(video);
  }

  // The answer of /api/avatar/speak is a run of pieces, in order. Either
  // each one is "4 bytes of length, then the MP4", or (when the browser can
  // reach the GPU box itself) each is a line of JSON naming a piece to
  // fetch from the box. Resolves once she has started speaking; rejects if
  // nothing could be played at all, so the caller can fall back to the
  // voice alone.
  async start(input: string, init: RequestInit): Promise<void> {
    const pieces = this.pieces;
    pieces.onended = () => this.onended?.();
    pieces.onstall = (stalled) => this.onstall?.(stalled);

    let started!: () => void;
    let failed!: (err: unknown) => void;
    const speaking = new Promise<void>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    pieces.onplay = () => {
      this.onplay?.();
      started();
    };

    (async () => {
      try {
        const [res] = await Promise.all([
          fetch(input, { ...init, signal: this.abort.signal }),
          pieces.open(),
        ]);
        if (!res.ok || !res.body) {
          throw new Error((await res.text().catch(() => "")) || `video request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        let pending = new Uint8Array(0);
        let count = 0;

        const direct = avatarBus.direct;
        if (direct && (res.headers.get("content-type") || "").includes("ndjson")) {
          // Each named piece is fetched as soon as its name arrives, and
          // joined when its turn comes.
          const text = new TextDecoder();
          let line = "";
          let turn: Promise<void> = Promise.resolve();
          const take = (id: string) => {
            const piece = fetch(`${direct.url}/piece/${id}`, { signal: this.abort.signal }).then(async (got) => {
              if (!got.ok) throw new Error(`piece failed (${got.status})`);
              return new Uint8Array(await got.arrayBuffer());
            });
            piece.catch(() => {});
            turn = turn.then(() => piece).then((bytes) => pieces.append(bytes)).then(() => {
              count += 1;
            });
          };
          while (true) {
            const { value, done } = await reader.read();
            if (value) line += text.decode(value, { stream: true });
            let end: number;
            while ((end = line.indexOf("\n")) >= 0) {
              const id = JSON.parse(line.slice(0, end)).id;
              line = line.slice(end + 1);
              if (typeof id === "string") take(id);
            }
            if (done) break;
          }
          await turn;
          if (!count) throw new Error("no video arrived");
          pieces.finish();
          return;
        }

        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            const joined = new Uint8Array(pending.length + value.length);
            joined.set(pending, 0);
            joined.set(value, pending.length);
            pending = joined;
          }
          // Take out every whole piece that has arrived.
          while (pending.length >= 4) {
            const length = new DataView(pending.buffer, pending.byteOffset).getUint32(0);
            if (pending.length < 4 + length) break;
            await pieces.append(pending.slice(4, 4 + length));
            pending = pending.slice(4 + length);
            count += 1;
          }
          if (done) break;
        }
        if (!count) throw new Error("no video arrived");
        pieces.finish();
      } catch (err) {
        if (pieces.isPlaying) {
          // Cut off part-way: what has arrived plays out.
          pieces.finish();
        } else {
          pieces.stop();
          failed(err);
        }
      }
    })();

    return speaking;
  }

  // Stops her mid-sentence. onended is not called.
  stop() {
    this.abort.abort();
    this.pieces.stop();
  }

  // The same call an <audio> element takes.
  pause() {
    this.stop();
  }
}
