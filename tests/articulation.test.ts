import assert from "node:assert/strict";
import test from "node:test";
import { alignSpeech, articulate, sampleSpeech, supportsArticulation } from "../src/lib/avatar/articulation";
import { LipSync } from "../src/lib/avatar/lipsync";

const sounds = (text: string) => articulate(text).map(phone => phone.viseme);

test("Urdu and Roman Urdu distinguish sealed lips, lip-to-teeth contact and rounded vowels", () => {
  assert.deepEqual(sounds("پھول"), ["PP", "U", "nn"]);
  assert.deepEqual(sounds("phool"), sounds("پھول"));
  assert.deepEqual(sounds("phone"), sounds("فون"));
  assert.deepEqual(sounds("phone"), ["FF", "O", "nn"]);
  assert.deepEqual(sounds("پانی"), sounds("paani"));
  assert.deepEqual(sounds("पानी"), sounds("paani"));
  assert.deepEqual(sounds("फ़ोन"), sounds("phone"));
  assert.deepEqual(sounds("फूल"), sounds("phool"));
  assert.deepEqual(sounds("بات"), sounds("baat"));
  assert.deepEqual(sounds("مُ"), ["PP", "U"]);
  assert.deepEqual(sounds("اور"), ["O", "RR"]);
  assert.deepEqual(sounds("aur"), sounds("اور"));
  assert.deepEqual(sounds("kaun"), ["kk", "O", "nn"]);
  assert.deepEqual(sounds("کون"), sounds("kaun"));
  assert.deepEqual(sounds("بات phone"), [...sounds("baat"), ...sounds("phone")]);
});

test("short words before a pause do not borrow speech from much longer words", () => {
  const pcm = new Float32Array(1700);
  pcm.fill(0.2, 100, 240);
  pcm.fill(0.2, 660, 1500);
  const cues = alignSpeech("baat فون", pcm, 1000);
  assert.equal(cues[0].start, 0.1);
  assert.equal(cues[cues.length - 1].end, 1.5);
  assert.equal(sampleSpeech(cues, 0.05), null);
  assert.equal(sampleSpeech(cues, 0.52), null);
  assert.deepEqual(sampleSpeech(cues, 0.67), { from: "FF", to: "FF", mix: 0 });
  assert.equal(sampleSpeech(cues, 1.55), null);
});

test("a recorded plosive release moves the seal-to-vowel boundary", () => {
  function releaseAt(ms: number) {
    const pcm = new Float32Array(400).fill(0.08);
    pcm.fill(0.8, ms);
    return alignSpeech("baa", pcm, 1000)[0].end;
  }
  assert.equal(releaseAt(100), 0.1);
  assert.equal(releaseAt(160), 0.16);
});

test("coarticulation blends neighbouring phones and respects recorded silence", () => {
  const cue = sampleSpeech([{ viseme: "PP", start: 0, end: 0.12 }, { viseme: "U", start: 0.12, end: 0.25 }], 0.12);
  assert.deepEqual(cue, { from: "PP", to: "U", mix: 0.5 });
  assert.deepEqual(alignSpeech("bol", new Float32Array(200), 1000), []);
});

test("both renderer formats seal, round and relax on voice disconnect", () => {
  const analyser = {
    fftSize: 1024, frequencyBinCount: 512, context: {sampleRate: 24000},
    getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.15),
    getByteFrequencyData: (arr: Uint8Array) => arr.fill(80),
  } as unknown as AnalyserNode;
  const lips = new LipSync();
  const sealed = lips.update(analyser, 0.08, {from: "PP", to: "PP", mix: 0});
  assert.equal(sealed.shapes.jawOpen, 0);
  assert.ok(sealed.shapes.mouthClose > 0.65);
  assert.ok(sealed.visemes!.viseme_PP > 0.75);
  const rounded = lips.update(analyser, 0.05, {from: "U", to: "U", mix: 0});
  assert.ok(rounded.shapes.mouthPucker > 0.55);
  assert.equal(lips.update(null, 0.01).shapes.jawOpen, 0);
});

test("numbers and symbols leave the recording to the acoustic mouth", () => {
  const speech = new Float32Array(400).fill(0.2);
  for (const text of ["3 pm", "۳ بجے", "دو + تین", "say 北京"]) {
    assert.equal(supportsArticulation(text), false);
    assert.deepEqual(alignSpeech(text, speech, 1000), []);
    assert.deepEqual(articulate(text), []);
  }
  assert.equal(supportsArticulation("فون، please!"), true);
});
