import assert from "node:assert/strict";
import { test } from "node:test";
import { Director, speechGesture, stageClock, type Unit } from "../src/lib/avatar/director";

test("gesture cues follow the last spoken clause across Urdu and English", () => {
  assert.equal(speechGesture("السّلام علیکم!"), "greet");
  assert.equal(speechGesture("Thanks! یہ کیسے ہوا؟"), "talk_lean");
  assert.equal(speechGesture("Ji, bohat shukriya."), "talk_chest");
  assert.equal(speechGesture("Pehle file open karein."), "talk_count");
  assert.equal(speechGesture("Mujhe pata nahi."), "talk_shrug");
  assert.equal(speechGesture("I highlighted the file."), "");
});

test("interruptions discard reserved frames of an unheard gesture", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { setInterval: () => 0, clearInterval: () => {} }, configurable: true,
  });
  try {
    const player = () => ({
      dataset: {}, load() {}, async play() {}, pause() {},
    }) as unknown as HTMLVideoElement;
    const units: Unit[] = [
      { name: "listen_still", pool: "listen", frames: 121, file: "", url: "listen" },
      { name: "talk_open", pool: "talk", frames: 121, file: "", url: "open" },
      { name: "talk_chest", pool: "talk", frames: 121, file: "", url: "chest" },
    ];
    const director = new Director([player(), player()], units, () => {}, () => "بہت شکریہ");
    director.start();
    const now = stageClock();
    director.turn("talk", now + 1);
    assert.equal(director.at(now + 2).unit.name, "talk_chest");
    director.claim(now + 3);
    director.cancelSpeech();
    assert.equal(director.at(now + 2).unit.name, "listen_still");
    director.stop();
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a gesture clip in which her own mouth moves is shown as it is only under a drawn head", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { setInterval: () => 0, clearInterval: () => {} }, configurable: true,
  });
  try {
    // The clip that is put in the player when she starts a line with an explaining gesture.
    const firstClip = (overlaid: boolean) => {
      const player = () => ({
        dataset: {}, load() {}, async play() {}, pause() {},
      }) as unknown as HTMLVideoElement;
      const players: [HTMLVideoElement, HTMLVideoElement] = [player(), player()];
      const units: Unit[] = [
        { name: "oa1_listen_neutral", pool: "listen", frames: 121, file: "", url: "neutral" },
        { name: "oa1_talk_explain", pool: "talk", cue: "explain", mouths: true, frames: 134, file: "", url: "explain" },
      ];
      const director = new Director(players, units, () => {});
      director.overlaid = overlaid;
      director.liveCall(true);
      director.want = "talk";
      director.gesture({ role: "explain", clause: 0 }, stageClock());
      director.start();
      const shown = players[0].dataset.unit;
      director.stop();
      return shown;
    };
    // The lip video draws her mouth on the gesture's frames itself: underneath, her mouth is still.
    assert.equal(firstClip(false), "oa1_listen_neutral");
    // The whole-face stream covers her head: the gesture plays underneath for her hands.
    assert.equal(firstClip(true), "oa1_talk_explain");
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
