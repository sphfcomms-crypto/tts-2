// Plays a streamed WAV as it downloads. The browser's own <audio> element
// waits until it has buffered a few seconds before it starts (measured:
// 2.7 to 4.4 s here, with the first audio on the wire after 1.3 s); this
// player schedules each chunk with Web Audio the moment it arrives. It also
// keeps what it received, so the same audio can be saved as a file.

const HEADER_BYTES = 44;
const MIN_CHUNK_SECONDS = 0.08;
const START_DELAY_SECONDS = 0.04;

// A streamed WAV says its length is unknown. This writes the real length
// into the header, so the file opens properly in other programs.
export function finishWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length < HEADER_BYTES) return bytes;
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  view.setUint32(4, out.length - 8, true);
  view.setUint32(40, out.length - HEADER_BYTES, true);
  return out;
}

export class StreamPlayer {
  onplay?: () => void;
  onended?: () => void;
  onerror?: (err: unknown) => void;
  // The whole clip, once it has fully arrived.
  onaudio?: (wav: Blob) => void;

  // Everything that is played passes through this node, for level meters.
  readonly analyser: AnalyserNode;

  private abort = new AbortController();
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private started = false;
  private downloaded = false;
  private stopped = false;

  constructor(private context: AudioContext) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(context.destination);
  }

  async start(url: string, init: RequestInit = {}) {
    try {
      const res = await fetch(url, { ...init, signal: this.abort.signal });
      if (!res.ok || !res.body) {
        throw new Error(
          (await res.text().catch(() => "")) ||
            `audio request failed (${res.status})`
        );
      }

      const reader = res.body.getReader();
      const received: Uint8Array[] = [];
      let header: Uint8Array = new Uint8Array(0);
      let sampleRate = 24000;
      let pending: Uint8Array = new Uint8Array(0); // PCM not yet scheduled

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received.push(value);
        let chunk = value;

        if (header.length < HEADER_BYTES) {
          const need = HEADER_BYTES - header.length;
          header = concat(header, chunk.subarray(0, need));
          chunk = chunk.subarray(need);
          if (header.length < HEADER_BYTES) continue;
          sampleRate = new DataView(
            header.buffer,
            header.byteOffset,
            header.byteLength
          ).getUint32(24, true);
        }

        pending = concat(pending, chunk);
        const minBytes = Math.floor(sampleRate * MIN_CHUNK_SECONDS) * 2;
        if (pending.length >= minBytes) {
          const usable = pending.length & ~1; // whole 16-bit samples only
          this.schedule(pending.subarray(0, usable), sampleRate);
          pending = pending.slice(usable);
        }
      }

      if (pending.length >= 2) {
        this.schedule(pending.subarray(0, pending.length & ~1), sampleRate);
      }
      this.downloaded = true;
      if (!this.started) throw new Error("the audio stream was empty");

      const whole = finishWav(received.reduce(concat, new Uint8Array(0)));
      this.onaudio?.(new Blob([new Uint8Array(whole)], { type: "audio/wav" }));
      this.finishIfIdle();
    } catch (err) {
      if (this.stopped) return;
      this.stop();
      this.onerror?.(err);
    }
  }

  // Stops playback and the download. onended is not called.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.analyser.disconnect();
  }

  // The same call an <audio> element takes, so callers can treat both alike.
  pause() {
    this.stop();
  }

  private schedule(pcm: Uint8Array, sampleRate: number) {
    if (this.stopped || pcm.length < 2) return;

    const samples = pcm.length / 2;
    const buffer = this.context.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);

    // Chunks play back to back. If the download fell behind, playback
    // simply resumes with the next chunk instead of overlapping.
    const now = this.context.currentTime + START_DELAY_SECONDS;
    const at = Math.max(now, this.nextTime);
    source.start(at);
    this.nextTime = at + buffer.duration;

    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.finishIfIdle();
    };

    if (!this.started) {
      this.started = true;
      this.onplay?.();
    }
  }

  private finishIfIdle() {
    if (this.stopped || !this.downloaded || this.sources.size > 0) return;
    this.stopped = true;
    this.analyser.disconnect();
    this.onended?.();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
