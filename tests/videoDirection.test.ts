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
