import * as THREE from "three";
import { avatarBus } from "./bus";
import { approach, LipSync } from "./lipsync";

// Makes the loaded character behave like a person: she breathes, blinks,
// shifts her weight, looks at you and away, listens, thinks, and when her
// voice plays her mouth, brows, head and hands move with it.
//
// Every body movement is given as a small rotation about her own axes
// (x: towards her left, y: up, z: towards the viewer) on top of the relaxed
// pose stored in the file, so nothing here depends on how the bones of a
// particular rig are rolled.

export type Manifest = {
  // role -> bone name in the file
  bones?: Record<string, string>;
  camera?: { position: number[]; target: number[]; fov: number };
  eyeHeight?: number;
};

type Role =
  | "hips" | "spine" | "spine1" | "chest" | "neck" | "head"
  | "leftShoulder" | "leftUpperArm" | "leftForearm" | "leftHand"
  | "rightShoulder" | "rightUpperArm" | "rightForearm" | "rightHand"
  | "leftEye" | "rightEye";

// Used when the manifest does not name a bone: common rig spellings.
const GUESS: Record<Role, RegExp> = {
  hips: /^(hips|pelvis|root)$/i,
  spine: /^(spine|spine0?1|spine_0?1|spine03)$/i,
  spine1: /^(spine1|spine0?2|spine_0?2)$/i,
  chest: /^(chest|spine2|spine0?3|spine_0?3|spine01)$/i,
  neck: /^(neck|neck0?1|neck_0?1)$/i,
  head: /^head$/i,
  leftShoulder: /^(leftshoulder|clavicle[._]?l|shoulder[._]?l)$/i,
  leftUpperArm: /^(leftarm|upperarm(01)?[._]?l|upper_arm[._]?l)$/i,
  leftForearm: /^(leftforearm|lowerarm(01)?[._]?l|forearm[._]?l)$/i,
  leftHand: /^(lefthand|hand[._]?l|wrist[._]?l)$/i,
  rightShoulder: /^(rightshoulder|clavicle[._]?r|shoulder[._]?r)$/i,
  rightUpperArm: /^(rightarm|upperarm(01)?[._]?r|upper_arm[._]?r)$/i,
  rightForearm: /^(rightforearm|lowerarm(01)?[._]?r|forearm[._]?r)$/i,
  rightHand: /^(righthand|hand[._]?r|wrist[._]?r)$/i,
  leftEye: /^(lefteye|eye[._]?l)$/i,
  rightEye: /^(righteye|eye[._]?r)$/i,
};

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

// One bone, turned each frame by angles about her own axes.
class Joint {
  x = 0;
  y = 0;
  z = 0;
  private rest: THREE.Quaternion;
  private parent: THREE.Quaternion; // parent's orientation in the rest pose
  private parentInverse: THREE.Quaternion;

  constructor(private bone: THREE.Object3D) {
    this.rest = bone.quaternion.clone();
    this.parent = new THREE.Quaternion();
    bone.parent?.getWorldQuaternion(this.parent);
    this.parentInverse = this.parent.clone().invert();
  }

  apply() {
    q1.setFromAxisAngle(Y, this.y);
    q1.multiply(q2.setFromAxisAngle(X, this.x));
    q1.multiply(q2.setFromAxisAngle(Z, this.z));
    // The same turn, expressed in the space of the bone's parent.
    this.bone.quaternion
      .copy(this.parentInverse)
      .multiply(q1)
      .multiply(this.parent)
      .multiply(this.rest);
    this.x = this.y = this.z = 0;
  }
}

// Smooth wandering between -1 and 1; a different seed gives another path.
const wander = (t: number, seed: number) =>
  (Math.sin(t * 0.73 + seed * 12.9) +
    Math.sin(t * 1.31 + seed * 4.1) * 0.6 +
    Math.sin(t * 2.17 + seed * 7.7) * 0.3) /
  1.9;

const ease = (x: number) => x * x * (3 - 2 * x);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const between = (a: number, b: number) => a + Math.random() * (b - a);

type Gesture = { side: -1 | 1 | 0; start: number; rise: number; hold: number; fall: number; size: number };

export class Performer {
  private joints = new Map<Role, Joint>();
  private morphs = new Map<string, { mesh: THREE.Mesh; index: number }[]>();
  private face: Record<string, number> = {};
  private mood: Record<string, number> = {};
  private lips = new LipSync();
  private ear = new Float32Array(512);

  private t = 0;
  private breath = 0;
  private spokeAt = -10;
  private speakingFor = 0;
  private average = 0;
  private afterglow = 0;

  private blinkAt = 2;
  private blinkStart = -1;
  private blinkAgain = false;

  private gaze = new THREE.Vector2();
  private gazeTarget = new THREE.Vector2();
  private gazeAt = 0;
  private awaySide = 1;
  private wasThinking = false;

  private head = new THREE.Vector3();
  private tilt = 0;
  private tiltAt = 0;
  private nod = -1;
  private nodAt = 0;
  private heard = 0;
  private heardFor = 0;

  private gesture: Gesture | null = null;
  private gestureAt = 0;
  private wasQuiet = 1;

  constructor(root: THREE.Object3D, manifest: Manifest = {}) {
    root.updateWorldMatrix(true, true);

    const clean = (name: string) => THREE.PropertyBinding.sanitizeNodeName(name);
    const bones: THREE.Object3D[] = [];
    root.traverse((node) => {
      if ((node as THREE.Bone).isBone) bones.push(node);
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
          if (!this.morphs.has(name)) this.morphs.set(name, []);
          this.morphs.get(name)!.push({ mesh, index });
        }
      }
    });

    for (const role of Object.keys(GUESS) as Role[]) {
      const named = manifest.bones?.[role];
      const bone = named
        ? bones.find((b) => b.name === named || b.name === clean(named))
        : bones.find((b) => GUESS[role].test(b.name));
      if (bone) this.joints.set(role, new Joint(bone));
    }
  }

  // What was found in the file, for checking a new model.
  describe() {
    return { joints: [...this.joints.keys()], morphs: [...this.morphs.keys()] };
  }

  private turn(role: Role, x: number, y = 0, z = 0) {
    const joint = this.joints.get(role);
    if (!joint) return;
    joint.x += x;
    joint.y += y;
    joint.z += z;
  }

  private shape(name: string, value: number) {
    this.face[name] = (this.face[name] ?? 0) + value;
  }

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

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const t = this.t;
    this.face = {};

    // ------------------------------------------------ what is she doing
    const mouth = this.lips.update(avatarBus.voice, dt);
    if (mouth.voiced) this.spokeAt = t;
    const speaking = t - this.spokeAt < 0.4;
    const wasSpeaking = this.speakingFor > 0;
    this.speakingFor = speaking ? this.speakingFor + dt : 0;
    if (wasSpeaking && !speaking) this.afterglow = 1; // a small smile after a line
    this.afterglow = approach(this.afterglow, 0, dt, 0.9);

    const heard = this.listen();
    this.heard = approach(this.heard, heard, dt, 0.15);
    const callerTalking = this.heard > 0.18;
    this.heardFor = callerTalking ? this.heardFor + dt : 0;

    let state: "speaking" | "thinking" | "listening" | "idle" = avatarBus.mood;
    if (speaking) state = "speaking";
    else if (callerTalking) state = "listening";

    // Emphasis: how much louder this moment is than her running average.
    this.average = approach(this.average, mouth.level, dt, 1.2);
    const stress = speaking ? clamp((mouth.level - this.average) * 2.4, 0, 1) : 0;

    // ------------------------------------------------------- breathing
    const rate = state === "speaking" ? 0.3 : state === "thinking" ? 0.2 : 0.24;
    this.breath += dt * rate * Math.PI * 2;
    // In faster than out.
    const air = 0.5 - 0.5 * Math.cos(this.breath + 0.5 * Math.sin(this.breath));
    const depth = state === "speaking" ? 0.7 : 1;
    this.turn("spine1", -0.008 * air * depth);
    this.turn("chest", -0.018 * air * depth);
    this.turn("leftShoulder", 0, 0, 0.022 * air * depth);
    this.turn("rightShoulder", 0, 0, -0.022 * air * depth);
    this.turn("neck", 0.012 * air * depth);

    // ------------------------------------------------- weight and sway
    const sway = wander(t * 0.35, 1);
    this.turn("hips", 0, 0.012 * wander(t * 0.3, 2), 0.006 * sway);
    this.turn("spine", 0.006 * wander(t * 0.4, 3), 0.02 * wander(t * 0.33, 4), -0.012 * sway);
    this.turn("chest", 0, 0.015 * wander(t * 0.45, 5), -0.006 * sway);
    for (const [arm, sign] of [["left", 1], ["right", -1]] as const) {
      this.turn(`${arm}UpperArm`, 0.012 * wander(t * 0.5, 6 + sign), 0, 0.008 * sign * wander(t * 0.4, 8 + sign));
      this.turn(`${arm}Forearm`, 0.02 * wander(t * 0.6, 10 + sign));
    }

    // ---------------------------------------------------------- head
    // A new resting tilt every few seconds, as people do.
    if (t > this.tiltAt) {
      this.tiltAt = t + between(2.5, 6);
      this.tilt = between(-1, 1);
    }
    const thinking = state === "thinking";
    if (thinking && !this.wasThinking) this.awaySide = Math.random() < 0.5 ? -1 : 1;
    this.wasThinking = thinking;

    let yaw = 0.045 * wander(t * 0.5, 20);
    let pitch = 0.025 * wander(t * 0.6, 21);
    let roll = 0.02 * this.tilt + 0.01 * wander(t * 0.4, 22);
    if (state === "speaking") {
      yaw += 0.06 * wander(t * 0.9, 23);
      pitch += 0.05 * stress + 0.02 * wander(t * 1.7, 24);
      roll += 0.03 * this.tilt;
    } else if (state === "listening") {
      pitch += 0.03;
      roll += 0.05 * Math.sign(this.tilt || 1);
    } else if (thinking) {
      yaw += 0.14 * this.awaySide;
      pitch -= 0.06;
      roll += 0.05 * this.awaySide;
    }

    // She nods when the caller finishes a phrase.
    if (this.nod < 0 && !callerTalking && this.heard > 0.04 && t > this.nodAt && avatarBus.ear) {
      this.nod = 0;
      this.nodAt = t + between(2.2, 4.5);
    }
    if (this.nod >= 0) {
      this.nod += dt / 0.55;
      pitch += 0.075 * Math.sin(Math.PI * Math.min(1, this.nod)) ** 2;
      if (this.nod >= 1) this.nod = -1;
    }

    this.head.set(
      approach(this.head.x, pitch, dt, 0.18),
      approach(this.head.y, yaw, dt, 0.25),
      approach(this.head.z, roll, dt, 0.3)
    );
    this.turn("neck", 0.4 * this.head.x, 0.4 * this.head.y, 0.4 * this.head.z);
    this.turn("head", 0.6 * this.head.x, 0.6 * this.head.y, 0.6 * this.head.z);

    // ---------------------------------------------------------- eyes
    if (t > this.gazeAt) {
      const away = thinking || (state !== "listening" && Math.random() < 0.18);
      if (thinking) {
        this.gazeTarget.set(this.awaySide * between(0.22, 0.34), -between(0.1, 0.22));
        this.gazeAt = t + between(0.7, 1.6);
      } else if (away) {
        this.gazeTarget.set(between(-0.22, 0.22), between(-0.04, 0.1));
        this.gazeAt = t + between(0.4, 1.1);
      } else {
        // On the viewer, never perfectly still.
        this.gazeTarget.set(between(-0.03, 0.03), between(-0.02, 0.03));
        this.gazeAt = t + between(0.9, 3.2);
      }
      // People blink when their eyes jump.
      if (this.gazeTarget.distanceTo(this.gaze) > 0.16 && this.blinkStart < 0) {
        this.blinkStart = t;
      }
    }
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, dt, 0.035);
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, dt, 0.035);
    // The eyes make up for the head, so the look stays where it was aimed.
    const eyeYaw = clamp(this.gaze.x - this.head.y, -0.45, 0.45);
    const eyePitch = clamp(this.gaze.y - this.head.x, -0.3, 0.3);
    const eyeBones = this.joints.has("leftEye") && this.joints.has("rightEye");
    if (eyeBones) {
      this.turn("leftEye", eyePitch, eyeYaw);
      this.turn("rightEye", eyePitch, eyeYaw);
    }
    // With eye bones these only move the lids along with the look.
    const lids = eyeBones ? 0.6 : 1.6;
    const toHerLeft = Math.max(0, eyeYaw) * lids;
    const toHerRight = Math.max(0, -eyeYaw) * lids;
    this.shape("eyeLookOutLeft", toHerLeft);
    this.shape("eyeLookInRight", toHerLeft);
    this.shape("eyeLookInLeft", toHerRight);
    this.shape("eyeLookOutRight", toHerRight);
    for (const side of ["Left", "Right"]) {
      this.shape(`eyeLookDown${side}`, Math.max(0, eyePitch) * lids * 1.4);
      this.shape(`eyeLookUp${side}`, Math.max(0, -eyePitch) * lids * 1.4);
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
          const mean = state === "speaking" ? 2.6 : state === "listening" ? 4.2 : 3.4;
          this.blinkAt = t + clamp(-Math.log(1 - Math.random()) * mean, 1, 8);
        }
      }
    }

    // ----------------------------------------------------- expression
    const want: Record<string, number> = {
      mouthSmileLeft: 0.1,
      mouthSmileRight: 0.1,
    };
    if (state === "listening") {
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
    } else if (state === "speaking") {
      want.mouthSmileLeft = want.mouthSmileRight = 0.12;
    }
    const names = new Set([...Object.keys(want), ...Object.keys(this.mood)]);
    for (const name of names) {
      this.mood[name] = approach(this.mood[name] ?? 0, want[name] ?? 0, dt, 0.28);
      this.shape(name, this.mood[name]);
    }
    // Brows lift on the words she stresses.
    this.shape("browInnerUp", 0.3 * stress);
    this.shape("browOuterUpLeft", 0.26 * stress);
    this.shape("browOuterUpRight", 0.26 * stress);
    this.shape("eyeWideLeft", 0.1 * stress);
    this.shape("eyeWideRight", 0.1 * stress);
    this.shape("mouthSmileLeft", 0.22 * this.afterglow);
    this.shape("mouthSmileRight", 0.22 * this.afterglow);
    this.shape("cheekSquintLeft", 0.12 * this.afterglow);
    this.shape("cheekSquintRight", 0.12 * this.afterglow);

    for (const [name, value] of Object.entries(mouth.shapes)) this.shape(name, value);
    // Lids: a blink wins over everything else; they also lower with a smile.
    this.face.eyeBlinkLeft = Math.max(lid, this.face.eyeBlinkLeft ?? 0);
    this.face.eyeBlinkRight = Math.max(lid, this.face.eyeBlinkRight ?? 0);

    // --------------------------------------------------------- hands
    const quiet = mouth.level < 0.2;
    if (speaking && !this.gesture && t > this.gestureAt && this.wasQuiet > 0.12 && mouth.level > 0.3 && this.speakingFor > 0.5) {
      const pick = Math.random();
      this.gesture = {
        side: pick < 0.4 ? 1 : pick < 0.8 ? -1 : 0,
        start: t,
        rise: between(0.28, 0.4),
        hold: between(0.5, 1.4),
        fall: between(0.45, 0.7),
        size: between(0.55, 1),
      };
    }
    this.wasQuiet = quiet ? this.wasQuiet + dt : 0;
    if (this.gesture) {
      const g = this.gesture;
      const p = t - g.start;
      // Speech stopping lets the hand drop early.
      const hold = speaking ? g.hold : Math.min(g.hold, p - g.rise);
      let amount: number;
      if (p < g.rise) amount = ease(p / g.rise);
      else if (p < g.rise + hold) amount = 1;
      else amount = 1 - ease(Math.min(1, (p - g.rise - hold) / g.fall));
      if (p >= g.rise + hold + g.fall) {
        this.gesture = null;
        this.gestureAt = t + between(1.6, 4.5);
      }
      const beat = amount * g.size;
      const pulse = 0.1 * mouth.level * amount;
      for (const [arm, sign] of [["left", 1], ["right", -1]] as const) {
        if (g.side !== 0 && g.side !== sign) continue;
        this.turn(`${arm}UpperArm`, -0.2 * beat, 0, 0.07 * sign * beat);
        this.turn(`${arm}Forearm`, -(0.95 * beat + pulse), -0.32 * sign * beat);
        this.turn(`${arm}Hand`, -0.18 * beat - pulse, 0.2 * sign * beat);
      }
      this.turn("chest", 0, -0.03 * g.side * beat);
    }

    // ---------------------------------------------------------- write
    for (const joint of this.joints.values()) joint.apply();
    for (const [name, targets] of this.morphs) {
      const value = clamp(this.face[name] ?? 0, 0, 1);
      for (const { mesh, index } of targets) mesh.morphTargetInfluences![index] = value;
    }
  }
}
