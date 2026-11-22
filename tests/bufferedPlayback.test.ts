import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWindows } from "../src/lib/avatar/bufferedPlayback";
import { scriptedShots } from "../src/lib/avatar/scriptedShots";
import type { Unit } from "../src/lib/avatar/director";

const units = ["talk_right", "talk_open", "talk_lean", "talk_chest", "listen_still", "listen_nod"].map(
  (name): Unit => ({ name, frames: 121, pool: name.startsWith("listen") ? "listen" : "talk", file: "" })
);

test("GPU render windows preserve every sample and start on the corresponding source frame", () => {
  for (const samples of [1, 959, 960, 961, 86400, 86401, 241337, 24000 * 120]) {
    let next = 0, frames = 0;
    const shots = scriptedShots(new Float32Array(samples), 24000, units, units[0], () => "");
    for (const w of renderWindows(samples, shots)) {
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

test("long speech completes a full gesture before a caption or pause selects the next source", () => {
  const unitSamples = 121 * 960;
  const words = ["", "Ji, bohat shukriya.", "", "کیا تم سن رہی ہو؟"];
  const pcm = new Float32Array(unitSamples * 4);
  pcm.fill(0.08);
  pcm.fill(0, 2 * unitSamples, 3 * unitSamples);
  const phraseAt = (seconds: number) => words[Math.floor(seconds * 25 / 121)];
  const shots = scriptedShots(pcm, 24000, units, units[0], phraseAt);
  assert.deepEqual(shots.map(s => s.clip), ["talk_right", "talk_chest", "listen_still", "talk_lean"]);
  assert.deepEqual(shots, scriptedShots(pcm, 24000, units, units[0], phraseAt));
  const windows = renderWindows(pcm.length, shots);
  for (const [i, shot] of shots.entries()) {
    assert.equal(shot.frame, 121 * i);
    const [first, last] = windows.slice(i * 2, i * 2 + 2);
    assert.deepEqual([first.clip, first.sourceFrame, first.frames], [shot.clip, 0, 90]);
    assert.deepEqual([last.clip, last.sourceFrame, last.frames], [shot.clip, 90, 31]);
    assert.equal(last.frame + last.frames, 121 * (i + 1));
    assert.equal(last.tail, i === 3 ? 0 : 4800);
    assert.equal(first.lead, i === 0 ? 0 : 4800);
  }
});

test("short lines keep the measured portrait and legacy single-clip installs keep their native cycle", () => {
  assert.equal(scriptedShots(new Float32Array(20000), 24000, units, units[0], () => "Thanks")[0].clip, "talk_right");
  const legacy = [units[0]];
  const pcm = new Float32Array(121 * 3 * 960);
  const shots = scriptedShots(pcm, 24000, legacy, legacy[0], () => "");
  assert.equal(shots.length, 1);
  assert.ok(renderWindows(pcm.length, shots).every(w => w.sourceFrame === w.frame));
});
