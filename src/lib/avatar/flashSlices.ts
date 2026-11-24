// The bookkeeping of the whole-face video (see flashTalk.ts), kept apart
// from the browser so it can be tested: cutting her voice into the slices
// the model draws, and knowing which piece of video belongs to the sound
// being heard.

// One slice of her voice on its way to be drawn.
export type Slice = {
  seq: number; // its number in this run of slices, from 0
  first: number; // the number of its first sample, counted since listening began
  samples: Int16Array;
};

// Cuts a stream of sound into slices of exactly `size` samples.
export class SliceCutter {
  private held: Int16Array;
  private filled = 0;
  private seq = 0;
  private heard = 0;

  constructor(readonly size: number) {
    this.held = new Int16Array(size);
  }

  push(block: Int16Array): Slice[] {
    const out: Slice[] = [];
    let at = 0;
    while (at < block.length) {
      const take = Math.min(this.size - this.filled, block.length - at);
      this.held.set(block.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === this.size) {
        out.push({ seq: this.seq++, first: this.heard, samples: this.held });
        this.heard += this.size;
        this.held = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return out;
  }

  // A new run begins with the next whole slice: its number is 0 again, and
  // the model starts her from the rest pose. Sound already held is kept, so
  // the count of samples stays in step with the clock.
  restart() {
    this.seq = 0;
  }
}

// Her voice as a plain WAV file (16-bit, one channel).
export function wav16(pcm: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + 2 * pcm.length);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + 2 * pcm.length, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2 * pcm.length, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + 2 * i, pcm[i], true);
  return out;
}

// One drawn slice: which stretch of her voice it shows (on the audio
// clock, as captured) and where it sits in the joined video.
export type Piece = {
  audioStart: number;
  length: number;
  mediaStart: number; // -1 until its video is in
};

// The pieces of one call, in order.
export class Timeline {
  private pieces: Piece[] = [];
  // Sound captured before this moment was thrown away (she was cut off),
  // so its pictures must not be shown: lips would move with nothing heard.
  private voidBefore = -Infinity;

  add(piece: Piece) {
    this.pieces.push(piece);
  }

  cut(at: number) {
    this.voidBefore = at;
  }

  // The piece that shows the sound captured at `spoken`, if there is one
  // and it may be shown. Pieces long past are forgotten.
  at(spoken: number): Piece | undefined {
    while (this.pieces.length && this.pieces[0].audioStart + this.pieces[0].length < spoken - 2) {
      this.pieces.shift();
    }
    if (spoken < this.voidBefore) return undefined;
    return this.pieces.find((p) => p.audioStart <= spoken && spoken < p.audioStart + p.length);
  }

  get size() {
    return this.pieces.length;
  }
}

// The model's lips run a little ahead of its own sound: 40 to 60 ms in the
// server's films, where her lips were closed at the moment of a p, b or m
// for 26 of 82 such sounds; with the pictures 40 to 60 ms later, for 53 to
// 58 (and for 12 with them earlier). So her voice is played this much
// before the pictures' clock. ?lipLag=<ms> in the page's address sets it
// for one device, from 0 to 150.
export const PICTURE_LAG = 0.05;

export function lipLead(search: string): number {
  const asked = new URLSearchParams(search).get("lipLag");
  const ms = asked === null || asked.trim() === "" ? NaN : Number(asked);
  return Number.isFinite(ms) ? Math.min(150, Math.max(0, ms)) / 1000 : PICTURE_LAG;
}

// When the first sample of her voice was captured, on the audio clock. A
// block of her voice reaches the page some time after its last sample was
// captured, never before, so each block gives a time no earlier than the
// truth, and the earliest of them is the best. It is settled while the
// first slice is gathered and kept from then on: every slice of a call is
// placed on the same clock. (Taken from the first block alone, it moved
// with how late that one block happened to be.)
export class FirstSample {
  private heard = 0;
  private settled = false;
  private known = false;
  at = 0;

  // now: the audio clock when the block arrived; samples and rate: its
  // length and the rate it was captured at.
  hear(now: number, samples: number, rate: number) {
    this.heard += samples;
    if (this.settled) return;
    const at = now - this.heard / rate;
    if (!this.known || at < this.at) this.at = at;
    this.known = true;
  }

  settle() {
    this.settled = true;
  }
}

// How long her voice is held back so that the pictures of a slice are
// there when its first sound is heard: what most slices really took (from
// their first sound being captured to their video being joined on), plus a
// margin that grows with how slow the line is.
export function holdFor(took: number[], slice: number, least: number, most: number): number {
  if (!took.length) return Math.min(most, Math.max(least, slice + 0.75));
  const sorted = [...took].sort((a, b) => a - b);
  const usual = sorted[Math.ceil((sorted.length - 1) * 0.92)];
  const margin = Math.max(0.15, 0.3 * (usual - slice));
  return Math.min(most, Math.max(least, usual + margin));
}

// How far the stream fades out inside the edges of the square the model
// draws, as a share of the square: enough to hide the join at her collar
// when her shoulders move in the clip underneath, and little enough to keep
// all of her hair.
const FADE_SIDE = 0.09;
const FADE_BOTTOM = 0.15;

// A CSS mask that shows a frame only inside that square, with soft edges:
// two gradients, one across and one down, of which the overlap is kept.
// square: left, top and size; width, height: the frame; all in its pixels.
export function squareMask([x, y, size]: [number, number, number], width: number, height: number) {
  const at = (value: number, whole: number) => `${((100 * value) / whole).toFixed(2)}%`;
  const side = FADE_SIDE * size;
  const top = y > 0 ? FADE_SIDE * size : 0; // a square at the frame's top edge has nothing above it to fade into
  const across =
    `linear-gradient(to right, transparent ${at(x, width)}, #000 ${at(x + side, width)}, ` +
    `#000 ${at(x + size - side, width)}, transparent ${at(x + size, width)})`;
  const down =
    `linear-gradient(to bottom, ${top ? `transparent ${at(y, height)}, ` : ""}#000 ${at(y + top, height)}, ` +
    `#000 ${at(y + size - FADE_BOTTOM * size, height)}, transparent ${at(y + size, height)})`;
  return `${across}, ${down}`;
}
