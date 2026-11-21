// What the avatar needs to know about the rest of the app, kept outside
// React: the render loop reads it sixty times a second.
//
//   voice  her voice as it is being played (Play button or live call)
//   ear    the caller's microphone during a live call
//   mood   what she is doing when she is not speaking

import type { Director } from "./director";

export type Mood = "idle" | "thinking" | "listening";

// The photo-real avatar on screen (VideoAvatar), as the lip sync sees it.
export type Stage = {
  // Her speaking (the frames with her lips drawn on) plays in this element.
  video: HTMLVideoElement;
  // Shows that element, or lets the clip underneath show again.
  speaking: (on: boolean) => void;
  // Tells the stage she has begun or ended a line, so her body gestures
  // while she talks.
  talking: (on: boolean) => void;
  // Plays her body-language clips and knows which frame shows when.
  director: Director;
};

// Where the browser can fetch her video itself: the GPU box's address and a
// pass that is good for a few minutes (renewed by AvatarPanel).
export type Direct = { url: string; token: string };

type Tap = { analyser: AnalyserNode; release: () => void };

const state = {
  voice: null as Tap | null,
  ear: null as Tap | null,
  mood: "idle" as Mood,
  stage: null as Stage | null,
  direct: null as Direct | null,
};
const watchers = new Set<(mood: Mood) => void>();

function tap(source: AudioNode): Tap {
  const analyser = source.context.createAnalyser();
  analyser.fftSize = 1024;
  // The mouth must not lag the sound, so the spectrum is barely smoothed.
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);
  return {
    analyser,
    release: () => {
      try {
        source.disconnect(analyser);
      } catch {}
    },
  };
}

function put(slot: "voice" | "ear", source: AudioNode) {
  state[slot]?.release();
  const mine = tap(source);
  state[slot] = mine;
  // Detaches this source, unless a newer one has taken its place.
  return () => {
    mine.release();
    if (state[slot] === mine) state[slot] = null;
  };
}

export const avatarBus = {
  // Her voice: any Web Audio node the sound passes through.
  attachVoice: (source: AudioNode) => put("voice", source),
  // The caller's microphone.
  attachEar: (source: AudioNode) => put("ear", source),
  setMood: (mood: Mood) => {
    if (state.mood === mood) return;
    state.mood = mood;
    watchers.forEach((watcher) => watcher(mood));
  },
  // Calls back whenever her mood changes; returns how to stop.
  onMood: (watcher: (mood: Mood) => void) => {
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  },
  setStage: (stage: Stage | null) => {
    state.stage = stage;
  },
  get stage() {
    return state.stage;
  },
  setDirect: (direct: Direct | null) => {
    state.direct = direct;
  },
  get direct() {
    return state.direct;
  },
  get voice() {
    return state.voice?.analyser ?? null;
  },
  get ear() {
    return state.ear?.analyser ?? null;
  },
  get mood() {
    return state.mood;
  },
};
