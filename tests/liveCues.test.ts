import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCues } from "../src/lib/avatar/liveCues";

function playback() {
  const cues = new LiveCues();
  let amplitude = 0;
  const context = { currentTime: 0 };
  const analyser = {
    fftSize: 64,
    context,
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(amplitude),
  } as unknown as AnalyserNode;
  return {
    cues,
    frame(t: number, speaking = true) {
      context.currentTime = t;
      amplitude = speaking ? 0.08 : 0;
      return cues.sample(analyser)?.from ?? null;
    },
  };
}

test("early captions wait for actual speech and preserve gaps between timed fragments", () => {
  const { cues, frame } = playback();
  cues.update("م", { startMs: 4500, endMs: 4650 });
  cues.update("م ف", { startMs: 4800, endMs: 5020 });
  assert.equal(frame(0, false), null);
  assert.equal(frame(4, false), null);
  assert.equal(frame(6), "PP");
  assert.equal(frame(6.2), null);
  assert.equal(frame(6.32), "FF");
  assert.equal(frame(6.34, false), null);
  assert.equal(frame(6.55), null);
});

test("late captions never restart mouth movements from a word already heard", () => {
  const { cues, frame } = playback();
  frame(2);
  frame(2.15);
  cues.update("p", { startMs: 500, endMs: 590 });
  assert.equal(frame(2.16), null);
  cues.update("p f", { startMs: 620, endMs: 830 });
  assert.equal(frame(2.22), "FF");
});

test("partial words can change the phone, then an interruption discards queued speech", () => {
  const { cues, frame } = playback();
  cues.update("s", { startMs: 1000, endMs: 1120 });
  cues.update("sh", { startMs: 1120, endMs: 1240 });
  assert.equal(frame(1), "CH");
  cues.clear();
  assert.equal(frame(1.05), null);
  cues.update("f", { startMs: 19000, endMs: 19300 });
  assert.equal(frame(1.10), "FF");
});

test("without timing, pauses do not spend the rest of the utterance", () => {
  const { cues, frame } = playback();
  cues.update("p f m");
  assert.equal(frame(1), "PP");
  frame(1.01, false);
  assert.equal(frame(2, false), null);
  assert.equal(frame(2.016), "PP");
  assert.equal(frame(2.1), "FF");
});

test("mixed numeric fragments leave a timed gap without stretching the surrounding words", () => {
  const { cues, frame } = playback();
  cues.update("p", { startMs: 800, endMs: 900 });
  cues.update("p 52 rupees", { startMs: 900, endMs: 1500 });
  cues.update("p 52 rupees f", { startMs: 1550, endMs: 1850 });
  assert.equal(frame(1), "PP");
  assert.equal(frame(1.3), null);
  assert.equal(frame(1.8), "FF");
});

test("untimed numbers do not make subsequent phones play early", () => {
  const { cues, frame } = playback();
  cues.update("p ۴۰");
  cues.update("p ۴۰ f");
  assert.equal(frame(1), null);
  assert.equal(frame(1.10), null);
  cues.clear();
  cues.update("f");
  assert.equal(frame(2), "FF");
});

test("timed cues resume after an untimed number when a session anchor exists", () => {
  const { cues, frame } = playback();
  cues.update("p", { startMs: 1800, endMs: 1900 });
  cues.update("p 7");
  cues.update("p 7 f", { startMs: 2500, endMs: 2720 });
  assert.equal(frame(1), "PP");
  assert.equal(frame(1.3), null);
  assert.equal(frame(1.8), "FF");
});
