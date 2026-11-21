// Helpers for raw speech audio: mono, 16-bit, 24 kHz, little-endian.

export const PCM_RATE = 24000;
const BYTES_PER_MS = (PCM_RATE * 2) / 1000;

// A WAV header. With no length it describes a stream of unknown size, which
// browsers play as it arrives.
export function wavHeader(dataBytes?: number): Uint8Array {
  const header = Buffer.alloc(44);
  const size = dataBytes ?? 0xffffffff - 36;
  header.write("RIFF", 0);
  header.writeUInt32LE(dataBytes === undefined ? 0xffffffff : 36 + size, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes === undefined ? 0xffffffff : size, 40);
  return new Uint8Array(header);
}

export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(wavHeader(pcm.length), 0);
  wav.set(pcm, 44);
  return wav;
}

export const silence = (ms: number) =>
  new Uint8Array(Math.round(ms * BYTES_PER_MS) & ~1);

// Cuts the quiet at both ends of a clip down to a short margin, so clips
// generated separately can be joined with pauses of a chosen length.
export function trimSilence(pcm: Uint8Array, keepMs = 60): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.length / 2);
  const window = Math.round(PCM_RATE * 0.01); // 10 ms
  const threshold = 0.012 * 32768;

  const loud = (start: number) => {
    let sum = 0;
    const end = Math.min(start + window, samples);
    for (let i = start; i < end; i++) {
      const value = view.getInt16(i * 2, true);
      sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, end - start)) > threshold;
  };

  let first = 0;
  while (first < samples && !loud(first)) first += window;
  let last = samples - window;
  while (last > first && !loud(last)) last -= window;
  if (first >= samples) return pcm.slice(0, 0);

  const margin = Math.round((keepMs / 1000) * PCM_RATE);
  const from = Math.max(0, first - margin);
  const to = Math.min(samples, last + window + margin);
  return pcm.slice(from * 2, to * 2);
}

// Finds the pause after a warm-up sentence at the start of a clip and
// returns the audio after it, or null when no such pause exists. Of the
// pauses in the plausible range, the one nearest to where the warm-up should
// end (by its share of the text) is used; tested on 36 clips, it cut every
// one cleanly.
export function cutWarmup(
  pcm: Uint8Array,
  warmupChars: number,
  lineChars: number
): Uint8Array | null {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frame = PCM_RATE / 100; // 10 ms
  const frames = Math.floor(pcm.length / 2 / frame);
  if (!frames) return null;

  const level = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < frame; i++) {
      const value = view.getInt16((f * frame + i) * 2, true) / 32768;
      sum += value * value;
    }
    level[f] = Math.sqrt(sum / frame);
    if (level[f] > peak) peak = level[f];
  }
  const threshold = Math.max(0.012, 0.04 * peak);
  const loud = (f: number) => level[f] > threshold;

  let start = 0;
  while (start < frames && !loud(start)) start++;
  let end = frames;
  while (end > start && !loud(end - 1)) end--;
  if (start >= end) return null;

  const MIN_WARMUP = 110; // frames: the warm-up is never shorter than 1.1 s
  const MAX_WARMUP = 360;
  const MIN_PAUSE = 14; // 140 ms
  const expected =
    start + ((end - start) * warmupChars) / (warmupChars + lineChars);

  let best = -1;
  let f = start + MIN_WARMUP;
  const limit = Math.min(end, start + MAX_WARMUP);
  while (f < limit) {
    if (loud(f)) {
      f++;
      continue;
    }
    let g = f;
    while (g < end && !loud(g)) g++;
    if (g - f >= MIN_PAUSE && g < end) {
      const middle = Math.floor((f + g) / 2);
      if (best < 0 || Math.abs(middle - expected) < Math.abs(best - expected)) {
        best = middle;
      }
    }
    f = g;
  }
  return best < 0 ? null : pcm.slice(best * frame * 2);
}
