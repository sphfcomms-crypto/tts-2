import assert from "node:assert/strict";
import { test } from "node:test";
import { holdFor, SliceCutter, squareMask, Timeline, wav16 } from "../src/lib/avatar/flashSlices";

test("her voice is cut into whole slices, in order, with nothing lost or repeated", () => {
  const cutter = new SliceCutter(1000);
  const blocks = [300, 800, 800, 2600, 500].map((length, k) => {
    const block = new Int16Array(length);
    for (let i = 0; i < length; i++) block[i] = (k * 1000 + i) % 30000;
    return block;
  });
  const all = Int16Array.from(blocks.flatMap((block) => [...block]));
  const slices = blocks.flatMap((block) => cutter.push(block));
  assert.deepEqual(slices.map((slice) => slice.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(slices.map((slice) => slice.first), [0, 1000, 2000, 3000, 4000]);
  for (const slice of slices) {
    assert.equal(slice.samples.length, 1000);
    assert.deepEqual([...slice.samples], [...all.subarray(slice.first, slice.first + 1000)]);
  }
});

test("a new run numbers its slices from 0 but keeps counting samples", () => {
  const cutter = new SliceCutter(100);
  cutter.push(new Int16Array(250));
  cutter.restart();
  const [next] = cutter.push(new Int16Array(50));
  assert.equal(next.seq, 0);
  assert.equal(next.first, 200);
});

test("a slice is sent as 16-bit mono WAV at its own rate", () => {
  const file = wav16(Int16Array.from([0, 1, -1, 32767, -32768]), 16000);
  const view = new DataView(file.buffer);
  assert.equal(String.fromCharCode(...file.subarray(0, 4)), "RIFF");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
  assert.equal(view.getInt16(44 + 6, true), 32767);
  assert.equal(view.getInt16(44 + 8, true), -32768);
});

test("the picture shown is the piece that holds the sound being heard", () => {
  const timeline = new Timeline();
  const first = { audioStart: 10, length: 0.96, mediaStart: 0 };
  const second = { audioStart: 10.96, length: 0.96, mediaStart: -1 };
  timeline.add(first);
  timeline.add(second);
  assert.equal(timeline.at(9.99), undefined);
  assert.equal(timeline.at(10), first);
  assert.equal(timeline.at(10.95), first);
  assert.equal(timeline.at(10.97), second);
  assert.equal(timeline.at(11.93), undefined);
});

test("after she is cut off, pictures of the sound that was dropped are not shown", () => {
  const timeline = new Timeline();
  timeline.add({ audioStart: 10, length: 0.96, mediaStart: 0 });
  timeline.add({ audioStart: 10.96, length: 0.96, mediaStart: 0.96 });
  timeline.cut(11.2);
  assert.equal(timeline.at(10.5), undefined);
  assert.equal(timeline.at(11.1), undefined);
  assert.equal(timeline.at(11.3)?.audioStart, 10.96);
});

test("pieces long past are forgotten", () => {
  const timeline = new Timeline();
  for (let i = 0; i < 20; i++) timeline.add({ audioStart: i, length: 1, mediaStart: i });
  // Heard now: 15.5. Pieces that ended more than two seconds ago are gone.
  timeline.at(15.5);
  assert.equal(timeline.size, 7);
});

test("her voice is held back for as long as most slices need, within its limits", () => {
  // Before anything is measured: the slice itself and a first allowance.
  assert.equal(holdFor([], 0.96, 1.1, 4), 0.96 + 0.75);
  // A fast line: slices take 1.3 s from first sound to pictures.
  const fast = holdFor([1.3, 1.31, 1.29, 1.3, 1.32], 0.96, 1.1, 4);
  assert.ok(fast >= 1.32 + 0.15 - 1e-9 && fast < 1.6, String(fast));
  // A slow line gets a wider margin, and never more than the most allowed.
  assert.ok(holdFor([2.4, 2.5, 2.6], 0.96, 1.1, 4) > 2.6 + 0.4);
  assert.equal(holdFor([6, 6, 6], 0.96, 1.1, 4), 4);
  assert.equal(holdFor([0.5, 0.5], 0.3, 1.1, 4), 1.1);
});

test("the stream is shown only inside the square the model draws, fading out towards its edges", () => {
  // The server's own frame: 960x720, her head and shoulders in the 300 pixels at the top middle.
  const [across, down] = squareMask([300, 0, 300], 960, 720).split("), ").map((part, i) => (i ? part : part + ")"));
  assert.equal(
    across,
    "linear-gradient(to right, transparent 31.25%, #000 34.06%, #000 59.69%, transparent 62.50%)"
  );
  // Nothing fades at the top (the square starts at the frame's edge); the bottom fades over 45 pixels.
  assert.equal(down, "linear-gradient(to bottom, #000 0.00%, #000 35.42%, transparent 41.67%)");
});

test("a square away from the frame's top edge fades out upwards too", () => {
  const mask = squareMask([100, 200, 400], 1000, 1000);
  assert.ok(mask.includes("to bottom, transparent 20.00%, #000 23.60%, #000 54.00%, transparent 60.00%"));
});
