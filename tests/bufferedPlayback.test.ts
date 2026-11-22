import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWindows } from "../src/lib/avatar/bufferedPlayback";

test("GPU render windows preserve every sample and start on the corresponding source frame", () => {
  for (const samples of [1, 959, 960, 961, 86400, 86401, 241337, 24000 * 120]) {
    let next = 0, frames = 0;
    for (const w of renderWindows(samples)) {
      assert.equal(w.start, next);
      assert.equal(w.frame, frames);
      assert.ok(w.start >= w.lead && w.end + w.tail <= samples);
      assert.ok(Number.isInteger(w.lead / 24) && Number.isInteger(w.tail / 24));
      assert.ok(44 + 2 * (w.end + w.tail - w.start + w.lead) <= 200000);
      next = w.end;
      frames += w.frames;
    }
    assert.equal(next, samples);
    assert.equal(frames, Math.ceil(samples / 960));
  }
});
