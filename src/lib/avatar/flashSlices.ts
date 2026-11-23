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
