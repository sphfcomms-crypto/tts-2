import { avatarBus } from "./bus";
import { speechGesture } from "./director";
import { approach, LipSync } from "./lipsync";

// Her face, as fifty-two numbers (the ARKit face shapes), sixty times a
// second: her mouth follows the sound of her voice, she blinks, her eyes
// move, her brows lift on the words she stresses, and her expression
// suits what she is doing. Used by the photo-real head (HeadAvatar), whose
// renderer takes exactly these shapes.

export type Doing = "Idle" | "Listening" | "Thinking" | "Responding";

// Every shape is given a number every time: the renderer breaks (draws
// nothing at all) if one is missing.
const SHAPES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight",
  "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
  "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
  "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
  "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthClose",
  "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthFunnel", "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
  "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "tongueOut",
];

const between = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ease = (x: number) => x * x * (3 - 2 * x);

// Both local renderers use the outgoing audio and microphone on the same
// frame. A short release holds the speaking pose between syllables. A caller
// taking the floor during a pause, or a detached output, ends it immediately.
export class SpeechTurn {
  private lips = new LipSync();
  private ear = new Float32Array(512);
  private heard = 0;
  private release = 0;
  private average = 0;
  private afterglow = 0;
  private doing: Doing = "Idle";
  private phrase = "";
  private gesture = "";

  private micLevel(): number {
    const ear = avatarBus.ear;
    if (!ear) return 0;
    if (this.ear.length !== ear.fftSize) this.ear = new Float32Array(ear.fftSize);
    ear.getFloatTimeDomainData(this.ear);
    let sum = 0;
    for (const sample of this.ear) sum += sample * sample;
    return clamp(Math.sqrt(sum / this.ear.length) / 0.08, 0, 1);
  }

  update(dt: number) {
    const voice = avatarBus.voice;
    const mouth = this.lips.update(voice, dt, avatarBus.viseme);
    const mic = this.micLevel();
    this.heard = approach(this.heard, mic, dt, mic > this.heard ? 0.04 : 0.15);
    const callerTalking = Boolean(avatarBus.ear) && this.heard > 0.18;
    this.release = mouth.voiced ? 0.22 : Math.max(0, this.release - dt);
    if (!voice || (callerTalking && !mouth.voiced)) this.release = 0;

    let doing: Doing = "Idle";
    if (this.release > 0) doing = "Responding";
    else if (callerTalking || avatarBus.mood === "listening") doing = "Listening";
    else if (avatarBus.mood === "thinking") doing = "Thinking";
    const phrase = doing === "Responding" ? avatarBus.phrase : "";
    if (phrase !== this.phrase) {
      this.phrase = phrase;
      this.gesture = phrase ? speechGesture(phrase) : "";
    }
    const questioning = this.gesture === "talk_lean";
    const changed = this.doing !== doing;
    if (this.doing === "Responding" && changed && !callerTalking) this.afterglow = 1;
    if (doing === "Responding") this.afterglow = 0;
    this.doing = doing;
    this.afterglow = approach(this.afterglow, 0, dt, 0.9);
    this.average = approach(this.average, mouth.level, dt, 1.2);
    const stress = mouth.voiced ? clamp((mouth.level - this.average) * 2.4, 0, 1) : 0;
    return { mouth, doing, changed, callerTalking, stress, questioning, afterglow: this.afterglow };
  }
}

export class Face {
  // What she is doing now; the renderer moves her head to suit it.
  doing: Doing = "Idle";

  private turn = new SpeechTurn();
  private mood: Record<string, number> = {};
  private t = 0;

  private blinkAt = 2;
  private blinkStart = -1;
  private blinkAgain = false;

  private gazeX = 0;
  private gazeY = 0;
  private gazeToX = 0;
  private gazeToY = 0;
  private gazeAt = 0;
  private awaySide = 1;
  private wasThinking = false;

  // dt: seconds since the last call. Returns the weight of each shape.
  update(dt: number): Record<string, number> {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const t = this.t;
    const face: Record<string, number> = {};
    for (const name of SHAPES) face[name] = 0;
    const add = (name: string, value: number) => {
      face[name] = (face[name] ?? 0) + value;
    };

    // ------------------------------------------------ what is she doing
    const { mouth, doing, changed, stress, questioning, afterglow } = this.turn.update(dt);
    this.doing = doing;
    const thinking = doing === "Thinking";
    const speaking = doing === "Responding";
    if (changed) this.gazeAt = 0;

    // ---------------------------------------------------------- eyes
    if (thinking && !this.wasThinking) this.awaySide = Math.random() < 0.5 ? -1 : 1;
    this.wasThinking = thinking;
    if (t > this.gazeAt) {
      const before = [this.gazeToX, this.gazeToY];
      if (thinking) {
        this.gazeToX = this.awaySide * between(0.22, 0.34);
        this.gazeToY = -between(0.1, 0.22);
        this.gazeAt = t + between(0.7, 1.6);
      } else if (this.doing !== "Listening" && Math.random() < 0.18) {
        this.gazeToX = between(-0.22, 0.22);
        this.gazeToY = between(-0.04, 0.1);
        this.gazeAt = t + between(0.4, 1.1);
      } else {
        // On the viewer, never perfectly still.
        this.gazeToX = between(-0.03, 0.03);
        this.gazeToY = between(-0.02, 0.03);
        this.gazeAt = t + between(0.9, 3.2);
      }
      // People blink when their eyes jump.
      const jump = Math.hypot(this.gazeToX - before[0], this.gazeToY - before[1]);
      if (jump > 0.16 && this.blinkStart < 0) this.blinkStart = t;
    }
    this.gazeX = approach(this.gazeX, this.gazeToX, dt, 0.035);
    this.gazeY = approach(this.gazeY, this.gazeToY, dt, 0.035);
    const toHerLeft = Math.max(0, this.gazeX) * 1.6;
    const toHerRight = Math.max(0, -this.gazeX) * 1.6;
    add("eyeLookOutLeft", toHerLeft);
    add("eyeLookInRight", toHerLeft);
    add("eyeLookInLeft", toHerRight);
    add("eyeLookOutRight", toHerRight);
    for (const side of ["Left", "Right"]) {
      add(`eyeLookDown${side}`, Math.max(0, this.gazeY) * 2.2);
      add(`eyeLookUp${side}`, Math.max(0, -this.gazeY) * 2.2);
    }

    // --------------------------------------------------------- blinks
    if (this.blinkStart < 0 && t > this.blinkAt) this.blinkStart = t;
    let lid = 0;
    if (this.blinkStart >= 0) {
      const p = t - this.blinkStart;
      if (p < 0.07) lid = ease(p / 0.07);
      else if (p < 0.1) lid = 1;
      else if (p < 0.24) lid = 1 - ease((p - 0.1) / 0.14);
      else {
        this.blinkStart = -1;
        if (!this.blinkAgain && Math.random() < 0.15) {
          this.blinkAgain = true;
          this.blinkAt = t + 0.12; // now and then, twice
        } else {
          this.blinkAgain = false;
          const mean = speaking ? 2.6 : this.doing === "Listening" ? 4.2 : 3.4;
          this.blinkAt = t + clamp(-Math.log(1 - Math.random()) * mean, 1, 8);
        }
      }
    }

    // ----------------------------------------------------- expression
    const want: Record<string, number> = { mouthSmileLeft: 0.1, mouthSmileRight: 0.1 };
    if (this.doing === "Listening") {
      want.mouthSmileLeft = want.mouthSmileRight = 0.2;
      want.browInnerUp = 0.12;
      want.cheekSquintLeft = want.cheekSquintRight = 0.08;
    } else if (thinking) {
      want.mouthSmileLeft = want.mouthSmileRight = 0;
      want.mouthPressLeft = want.mouthPressRight = 0.25;
      want.mouthLeft = this.awaySide > 0 ? 0.15 : 0;
      want.mouthRight = this.awaySide < 0 ? 0.15 : 0;
      want.browInnerUp = 0.2;
      want.browDownLeft = 0.14;
      want.eyeSquintLeft = want.eyeSquintRight = 0.18;
    } else if (speaking) {
      want.browInnerUp = questioning ? 0.18 : 0;
    }
    for (const name of new Set([...Object.keys(want), ...Object.keys(this.mood)])) {
      this.mood[name] = approach(this.mood[name] ?? 0, want[name] ?? 0, dt, 0.28);
      // A smile or pressed thinking pose must yield to the spoken mouth shape.
      add(name, speaking && name.startsWith("mouth") ? 0 : this.mood[name]);
    }
    // Brows lift on the words she stresses.
    add("browInnerUp", 0.3 * stress);
    add("browOuterUpLeft", 0.26 * stress);
    add("browOuterUpRight", 0.26 * stress);
    add("eyeWideLeft", 0.1 * stress);
    add("eyeWideRight", 0.1 * stress);
    add("mouthSmileLeft", 0.22 * afterglow);
    add("mouthSmileRight", 0.22 * afterglow);
    add("cheekSquintLeft", 0.12 * afterglow);
    add("cheekSquintRight", 0.12 * afterglow);

    for (const [name, value] of Object.entries(mouth.shapes)) add(name, value);
    // A blink wins over everything else the lids are doing.
    face.eyeBlinkLeft = Math.max(lid, face.eyeBlinkLeft ?? 0);
    face.eyeBlinkRight = Math.max(lid, face.eyeBlinkRight ?? 0);

    for (const name of Object.keys(face)) face[name] = clamp(face[name], 0, 1);
    return face;
  }
}
