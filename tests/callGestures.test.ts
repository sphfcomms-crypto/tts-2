import assert from "node:assert/strict";
import { test } from "node:test";
import { CallTurns } from "../src/lib/callTurns";
import { CallGestures } from "../src/lib/avatar/callGestures";
import { Director, stageClock, type Unit } from "../src/lib/avatar/director";

test("real caller worries and step-by-step requests lead distinct reactions before captions", () => {
  const cues = new CallGestures();
  cues.caller("इंटरव्यू में दिमाग बिलकुल खाली हो गया, अभी तक बुरा लग रहा है।");
  cues.hear(4.5, .05, .07, true);
  assert.deepEqual(cues.cue(4.5, true), { role: "reflect", clause: 0 });
  cues.update("Samajh sakti hoon.", { startMs: 5620, endMs: 5950 });
  cues.caller("जवाब पहले कैसे शुरू करूँ और फिर क्या कहूँ?");
  cues.hear(18.5, .05, .06, true);
  assert.deepEqual(cues.cue(18.5, true), { role: "count", clause: 0 });
  assert.equal(cues.cue(19), null);
});

test("the recorded Urdu interview reply starts with sympathy before its delayed empathy caption", () => {
  const cues = new CallGestures();
  const turns = new CallTurns({ update: (text, span) => cues.update(text, span), clear: () => cues.clearCaptions() });
  // Arrival, role, delta and session start from the real WebRTC call. The
  // first emphasize clip was previously appended at 14276 ms, before
  // "سمجھ سکتی" arrived at 14802/14999 ms. The caller's PCM ended at 12155 ms.
  const events = [
    [9695, "you", " یار", 6200], [10156, "you", "، انٹ", 6600], [10327, "you", "رویو میں", 6800],
    [10504, "you", " میرا", 7000], [10903, "you", " دماغ", 7400], [11288, "you", " بالکل", 7800],
    [11816, "you", " خالی ہو", 8200], [11817, "her", " آہ", 8200], [12000, "you", " گیا", 8400],
    [12001, "her", "۔", 8400], [12606, "you", " ابھی", 9000], [12808, "you", " تک", 9200],
    [12946, "you", " برا", 9400], [13225, "you", " لگ", 9600], [13388, "you", " رہا ہے", 9800],
    [13389, "her", " او", 9800], [13816, "her", " یار", 10200], [14002, "her", "،", 10400],
  ] as const;
  for (const [arrival, who, fragment, startMs] of events) {
    const span = { startMs, endMs: startMs + 200 };
    if (who === "her") turns.assistant(fragment, span);
    else if (turns.caller(span, arrival < 12155 + 650)) cues.caller(fragment);
  }
  cues.hear(0, .15, .09, true);
  assert.equal(cues.cue(0, true)?.role, "reflect");
});

test("acknowledgment alone does not exaggerate emphasis and empathy is explicit in all three scripts", () => {
  const classify = (line: string, rms = .015) => {
    const cues = new CallGestures();
    cues.update(line);
    cues.hear(0, .2, rms, true);
    return cues.cue(0, true)?.role;
  };
  for (const line of ["Haan, bilkul", "हाँ बिल्कुल", "ہاں بالکل"]) {
    assert.notEqual(classify(line), "emphasize", line);
  }
  for (const line of ["Main samajh sakti hoon", "Main samjh rahi hoon", "میں سمجھ سکتی ہوں", "मैं समझ सकती हूँ"]) {
    assert.equal(classify(line, .09), "reflect", line);
  }
  assert.equal(classify("Bilkul zaroori hai"), "emphasize");
  assert.equal(classify("क्या सवाल था?"), "ask");
  assert.equal(classify("पहले जवाब बताओ"), "count");
});

test("future transcript cannot trigger an action in an earlier voiced clause", () => {
  const cues = new CallGestures();
  cues.update("Mujhe afsos hai.", { startMs: 8000, endMs: 8700 });
  cues.update("Mujhe afsos hai. Pehle apna naam batao.", { startMs: 10400, endMs: 11400 });
  cues.hear(2, 1.7, .02, true);
  cues.hear(4.4, 1.5, .045, true);
  assert.equal(cues.cue(2.2)?.role, "reflect");
  assert.equal(cues.cue(3.1), null);
  assert.equal(cues.cue(4.05), null);
  assert.equal(cues.cue(4.64)?.role, "count");
  // Once a real pause begins the old subtitle never drives a resting face.
  assert.equal(cues.cue(6.15), null);
});

test("a late untimed caption can use the next prosodic boundary and interruption clears it", () => {
  const cues = new CallGestures();
  cues.hear(0, 1.4, .015, true);
  assert.equal(cues.cue(0)?.role, "reflect");
  cues.update("Bohat shukriya!");
  assert.equal(cues.cue(1.35), null);
  cues.hear(1.9, .25, .04, true);
  assert.equal(cues.cue(1.9)?.role, "warm");
  cues.caller("Mujhe samjha dein.");
  assert.equal(cues.cue(1.9), null);
  cues.hear(4, .25, .02, true);
  assert.equal(cues.cue(4)?.role, "explain");
});

test("a real talk film keeps its registered body through an in-motion semantic change", () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { setInterval: () => 0, clearInterval() {} }, configurable: true });
  try {
    const player = () => ({ dataset: {}, load() {}, async play() {}, pause() {} }) as unknown as HTMLVideoElement;
    const quiet: Unit = { name: "oa1_listen_neutral", pool: "listen", frames: 121, file: "q", url: "q" };
    const reflect: Unit = { name: "oa1_talk_reflect", pool: "talk", cue: "reflect", frames: 139, rise: 6, release: 118, mouths: true, file: "r", url: "r" };
    const explain: Unit = { ...reflect, name: "oa1_talk_explain", cue: "explain", frames: 134, url: "e" };
    const d = new Director([player(), player()], [quiet, reflect, explain], () => {});
    d.start(); d.liveCall(true);
    const t = stageClock();
    d.gesture({ role: "reflect", clause: 0 }, t + 1);
    d.turn("talk", t + 1);
    assert.equal(d.at(t + 1.4).unit, reflect);
    const was = d.at(t + 2.3);
    d.claim(t + 2.4);
    d.gesture({ role: "count", clause: 1 }, t + 2.9);
    assert.deepEqual(d.at(t + 2.3), was);
    assert.equal(d.at(t + 3).unit, reflect);
    assert.equal(d.at(t + 6.5).unit, explain);
    // No accidental repetition of the counting action in a long clause.
    assert.equal(d.at(t + 12).unit, reflect);
    d.cancelSpeech();
    assert.equal(d.at(t + 2).unit, quiet);
    d.stop();
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a waiting GPU chunk exposes only a genuine quiet take underneath", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldClock = Object.getOwnPropertyDescriptor(performance, "now");
  let time = 10, tick: (() => void) | undefined;
  Object.defineProperty(performance, "now", { value: () => time * 1000, configurable: true });
  Object.defineProperty(globalThis, "window", { value: {
    setInterval(fn: () => void) { tick = fn; return 0; }, clearInterval() {}, setTimeout() {},
  }, configurable: true });
  try {
    const player = () => ({ dataset: {}, load() {}, async play() {}, pause() {},
      currentTime: 0, readyState: 3, paused: false, seeking: false }) as unknown as HTMLVideoElement;
    const players: [HTMLVideoElement, HTMLVideoElement] = [player(), player()];
    const quiet: Unit = { name: "oa1_listen_neutral", pool: "listen", frames: 121, file: "quiet", url: "quiet" };
    const speaking: Unit = { name: "oa1_talk_explain", pool: "talk", cue: "explain", mouths: true,
      frames: 134, file: "recorded-other-speech", url: "recorded-other-speech" };
    const d = new Director(players, [quiet, speaking], () => {});
    assert.equal(d.filmReady, true);
    d.start(); d.liveCall(true);
    d.gesture({ role: "explain", clause: 0 }, 11);
    d.turn("talk", 11);
    time = 11.2;
    tick!();
    assert.equal(d.at(time).unit, speaking);
    assert.ok(players.every(p => p.src !== speaking.url));
    assert.ok(players.some(p => p.dataset.unit === quiet.name));
    d.stop();
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldClock) Object.defineProperty(performance, "now", oldClock);
    else Reflect.deleteProperty(performance, "now");
  }
});
