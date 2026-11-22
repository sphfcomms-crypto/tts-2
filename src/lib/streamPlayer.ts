import { alignSpeech, sampleSpeech, type TimedViseme, type VisemeBlend } from "./avatar/articulation";
import { PIECE_MEDIA_TYPE, SpeechFrameReader } from "./speechFrames";

const HEADER_BYTES = 44;
const START_DELAY_SECONDS = 0.04;

function setWavLength(header: Uint8Array, dataBytes: number) {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(40, dataBytes, true);
}

// A streamed WAV says its length is unknown. Write the actual length once
// it has arrived, so the file opens properly in other programs.
export function finishWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length < HEADER_BYTES) return bytes;
  const out = bytes.slice();
  setWavLength(out, out.length - HEADER_BYTES);
  return out;
}

type Span = { start: number; end: number; text: string; cues: TimedViseme[] };

class ClipTimeline {
  private spans: Span[] = [];

  add(span: Span) {
    this.spans.push(span);
  }

  private at(time: number) {
    let low = 0;
    let high = this.spans.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const span = this.spans[mid];
      if (time < span.start) high = mid;
      else if (time >= span.end) low = mid + 1;
      else return span;
    }
  }

  phraseAt(time: number) {
    return this.at(time)?.text ?? "";
  }

  visemeAt(time: number): VisemeBlend | null {
    const span = this.at(time);
    return span ? sampleSpeech(span.cues, time - span.start) : null;
  }
}

const clipTimelines = new WeakMap<Blob, ClipTimeline>();
export const getClipTimeline = (clip: Blob) => clipTimelines.get(clip);

export class StreamPlayer {
  onplay?: () => void;
  onended?: () => void;
  onerror?: (err: unknown) => void;
  onaudio?: (wav: Blob) => void;
  readonly analyser: AnalyserNode;

  private abort = new AbortController();
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private downloaded = false;
  private stopped = false;
  // Network stalls add silence to the live clock. The saved WAV contains
  // only the audio and the explicitly inserted pauses.
  private playback = new ClipTimeline();

  constructor(
    private context: AudioContext,
    output: AudioNode | null = context.destination
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    if (output) this.analyser.connect(output);
  }

  get viseme() {
    return this.stopped ? null : this.playback.visemeAt(this.context.currentTime);
  }

  get phrase() {
    return this.stopped ? "" : this.playback.phraseAt(this.context.currentTime);
  }

  async start(url: string, init: RequestInit = {}, readyForPlayback?: Promise<void>) {
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", PIECE_MEDIA_TYPE);
      const res = await fetch(url, { ...init, headers, signal: this.abort.signal });
      if (!res.ok || !res.body) {
        throw new Error((await res.text().catch(() => "")) || `audio request failed (${res.status})`);
      }
      if (res.headers.get("content-type")?.split(";")[0] !== PIECE_MEDIA_TYPE) {
        throw new Error("The server did not return a framed speech stream.");
      }

      const reader = new SpeechFrameReader(res.body.getReader());
      const wav = await reader.bytes(HEADER_BYTES);
      const sampleRate = new DataView(wav.buffer).getUint32(24, true);
      if (sampleRate !== 24000) throw new Error("Invalid speech sample rate.");
      const chunks: BlobPart[] = [wav];
      const replay = new ClipTimeline();
      let dataBytes = 0;
      for (let frame = await reader.next(); frame; frame = await reader.next()) {
        if (!this.nextTime && readyForPlayback) await readyForPlayback;
        if (this.stopped) return;
        const { text, pcm, gapSamples } = frame;
        const fileTime = dataBytes / (2 * sampleRate);
        const span = this.schedule(text, pcm, gapSamples, sampleRate);
        if (span) {
          replay.add({ ...span, start: fileTime, end: fileTime + pcm.length / (2 * sampleRate) });
        }
        chunks.push(pcm);
        if (gapSamples) chunks.push(new Uint8Array(gapSamples * 2));
        dataBytes += pcm.length + gapSamples * 2;
      }
      if (this.stopped) return;
      if (!this.nextTime) throw new Error("The audio stream was empty.");
      setWavLength(wav, dataBytes);
      const clip = new Blob(chunks, { type: "audio/wav" });
      clipTimelines.set(clip, replay);
      this.downloaded = true;
      this.onaudio?.(clip);
      this.finishIfIdle();
    } catch (err) {
      if (this.stopped) return;
      this.stop();
      this.onerror?.(err);
    }
  }

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

  pause() {
    this.stop();
  }

  private schedule(text: string, pcm: Uint8Array, gapSamples: number, sampleRate: number) {
    const samples = pcm.length / 2;
    if (!samples && !gapSamples) return;
    const buffer = this.context.createBuffer(1, samples + gapSamples, sampleRate);
    const speech = buffer.getChannelData(0).subarray(0, samples);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) speech[i] = view.getInt16(i * 2, true) / 32768;
    const cues = alignSpeech(text, speech, sampleRate);
    const first = !this.nextTime;
    const start = Math.max(this.context.currentTime + START_DELAY_SECONDS, this.nextTime);
    const span = { start, end: start + samples / sampleRate, text, cues };
    this.playback.add(span);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.finishIfIdle();
    };
    if (first) this.onplay?.();
    return span;
  }

  private finishIfIdle() {
    if (this.stopped || !this.downloaded || this.sources.size > 0) return;
    this.stopped = true;
    this.analyser.disconnect();
    this.onended?.();
  }
}
