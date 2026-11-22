import assert from "node:assert/strict";
import { test } from "node:test";
import { CallAudioHandoff, CallCueHistory } from "../src/lib/avatar/callAudioHandoff";
import { CallVideoHealth } from "../src/lib/avatar/callVideoHealth";

test("waits through call silence and normal render latency, then times out on a missing first word", () => {
  const health = new CallVideoHealth();
  assert.equal(health.missedDeadline(30, false, false), false);
  health.expect(31.5);
  assert.equal(health.missedDeadline(31.6, true, false), false);
  assert.equal(health.missedDeadline(33.51, false, false), true);
});

test("holds the GPU through an isolated late piece, brief stall or long natural pause", () => {
  const health = new CallVideoHealth();
  health.expect(1);
  assert.equal(health.missedDeadline(1, true, true), false);
  assert.equal(health.missedDeadline(2, true, false), false);
  assert.equal(health.missedDeadline(2.2, true, true), false);
  assert.equal(health.missedDeadline(60, false, false), false);
  for (const lag of [2.5, 0.05, 2.5, 2.1]) assert.equal(health.joined(lag), false);
  assert.equal(health.joined(2.4), true);
});

test("switches when frames stop being displayed during active speech", () => {
  const health = new CallVideoHealth();
  health.expect(1);
  assert.equal(health.missedDeadline(1.2, true, true), false);
  assert.equal(health.missedDeadline(2.1, true, false), false);
  assert.equal(health.missedDeadline(4.11, true, false), true);
});


test("a continuous reply drains without a jump and a natural pause permits an earlier switch", () => {
  const calls: number[][] = [];
  const delay = {
    cancelScheduledValues() {},
    setValueAtTime(value: number, time: number) { calls.push([value, time]); },
    linearRampToValueAtTime(value: number, time: number) { calls.push([value, time]); },
  } as unknown as AudioParam;
  const bridge = new CallAudioHandoff(1.5, 10, delay);
  assert.deepEqual(calls, [[1.5, 10], [1.5, 12], [0, 27]]);
  assert.equal(bridge.remaining(10), 1.5);
  assert.equal(bridge.remaining(27), 0);
  assert.equal(bridge.drained(10, true), false);
  assert.equal(bridge.drained(11, false), false);
  assert.equal(bridge.drained(12, true), false);
  assert.equal(bridge.drained(13, true), false);
  assert.equal(bridge.drained(13.7, true), true);
  assert.equal(bridge.drained(27, false), true);
});

test("portrait uses the lip shape and phrase of the word still at the speaker", () => {
  const cues = new CallCueHistory();
  cues.record(3, null, "پہلی");
  cues.record(4, null, "اگلی");
  assert.equal(cues.at(4.2 - 1)?.phrase, "پہلی");
  assert.equal(cues.at(4.2)?.phrase, "اگلی");
});
