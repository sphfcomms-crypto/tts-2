import { avatarBus } from "./bus";
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

export class Face {
  // What she is doing now; the renderer moves her head to suit it.
  doing: Doing = "Idle";

  private lips = new LipSync();
  private ear = new Float32Array(512);
  private mood: Record<string, number> = {};
  private t = 0;
  private spokeAt = -10;
  private wasSpeaking = false;
  private average = 0;
  private afterglow = 0;
  private heard = 0;

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

  // Loudness of the caller's microphone, 0 to 1.
  private listen(): number {
    const ear = avatarBus.ear;
    if (!ear) return 0;
    if (this.ear.length !== ear.fftSize) this.ear = new Float32Array(ear.fftSize);
    ear.getFloatTimeDomainData(this.ear);
    let sum = 0;
    for (let i = 0; i < this.ear.length; i++) sum += this.ear[i] ** 2;
    return clamp(Math.sqrt(sum / this.ear.length) / 0.08, 0, 1);
  }

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
    const mouth = this.lips.update(avatarBus.voice, dt);
    if (mouth.voiced) this.spokeAt = t;
    const speaking = t - this.spokeAt < 0.4;
    if (this.wasSpeaking && !speaking) this.afterglow = 1; // a small smile after a line
    this.wasSpeaking = speaking;
    this.afterglow = approach(this.afterglow, 0, dt, 0.9);

    this.heard = approach(this.heard, this.listen(), dt, 0.15);
    const callerTalking = this.heard > 0.18;
    const thinking = !speaking && !callerTalking && avatarBus.mood === "thinking";
    this.doing = speaking
      ? "Responding"
      : callerTalking || avatarBus.mood === "listening"
        ? "Listening"
        : thinking
          ? "Thinking"
          : "Idle";

    // Emphasis: how much louder this moment is than her running average.
    this.average = approach(this.average, mouth.level, dt, 1.2);
    const stress = speaking ? clamp((mouth.level - this.average) * 2.4, 0, 1) : 0;

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
      want.mouthSmileLeft = want.mouthSmileRight = 0.12;
    }
    for (const name of new Set([...Object.keys(want), ...Object.keys(this.mood)])) {
      this.mood[name] = approach(this.mood[name] ?? 0, want[name] ?? 0, dt, 0.28);
      add(name, this.mood[name]);
    }
    // Brows lift on the words she stresses.
    add("browInnerUp", 0.3 * stress);
    add("browOuterUpLeft", 0.26 * stress);
    add("browOuterUpRight", 0.26 * stress);
    add("eyeWideLeft", 0.1 * stress);
    add("eyeWideRight", 0.1 * stress);
    add("mouthSmileLeft", 0.22 * this.afterglow);
    add("mouthSmileRight", 0.22 * this.afterglow);
    add("cheekSquintLeft", 0.12 * this.afterglow);
    add("cheekSquintRight", 0.12 * this.afterglow);

    for (const [name, value] of Object.entries(mouth.shapes)) add(name, value);
    // A blink wins over everything else the lids are doing.
    face.eyeBlinkLeft = Math.max(lid, face.eyeBlinkLeft ?? 0);
    face.eyeBlinkRight = Math.max(lid, face.eyeBlinkRight ?? 0);

    for (const name of Object.keys(face)) face[name] = clamp(face[name], 0, 1);
    return face;
  }
}
