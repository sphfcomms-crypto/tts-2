// What the avatar needs to know about the rest of the app, kept outside
// React: the render loop reads it sixty times a second.
//
//   voice  her voice as it is being played (Play button or live call)
//   ear    the caller's microphone during a live call
//   mood   what she is doing when she is not speaking

import { LiveCues } from "./liveCues";
import type { VisemeBlend } from "./articulation";
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

export type SpeechCues = {
  sample: (voice: AnalyserNode) => VisemeBlend | null;
  phrase: () => string;
};

// A call can stay connected while a script plays. Each source owns its cues
// and releasing a script restores the underlying call's analyser.
const voices: (Tap & { cues?: SpeechCues })[] = [];
const currentVoice = () => voices[voices.length - 1];

const state = {
  ear: null as Tap | null,
  mood: "idle" as Mood,
  stage: null as Stage | null,
  direct: null as Direct | null,
};
let videoAvailable: boolean | undefined;
const stageChanges = new Set<() => void>();
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

function attachEar(source: AudioNode) {
  state.ear?.release();
  const mine = tap(source);
  state.ear = mine;
  // Detaches this source, unless a newer one has taken its place.
  return () => {
    mine.release();
    if (state.ear === mine) state.ear = null;
  };
}

export const avatarBus = {
  // Her voice: any Web Audio node the sound passes through.
  attachVoice(source: AudioNode, cues?: SpeechCues) {
    const mine = { ...tap(source), cues };
    voices.push(mine);
    return () => {
      const index = voices.indexOf(mine);
      if (index < 0) return;
      voices.splice(index, 1);
      mine.release();
    };
  },
  startLiveSpeech() {
    const live = new LiveCues();
    let phrase = "";
    let released = false;
    const clear = () => {
      phrase = "";
      live.clear();
    };
    return {
      update(text: string, span?: { startMs: number; endMs: number }) {
        if (released) return;
        phrase = text;
        live.update(text, span);
      },
      clear,
      sample: (voice: AnalyserNode) => released ? null : live.sample(voice),
      phrase: () => phrase,
      release() {
        released = true;
        clear();
      },
    };
  },
  // The caller's microphone.
  attachEar,
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
    stageChanges.forEach(notify => notify());
  },
  setVideoAvailable(value: boolean | undefined) {
    videoAvailable = value;
    stageChanges.forEach(notify => notify());
  },
  // Wait before buying/opening the voice session. Opening it as soon as
  // the microphone is ready can permanently select the local face on a cold page.
  waitForStage(signal: AbortSignal) {
    if (state.stage || videoAvailable === false || signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const finish = () => {
        window.clearTimeout(timer);
        stageChanges.delete(check);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const check = () => { if (state.stage || videoAvailable === false) finish(); };
      const timer = window.setTimeout(finish, 8000);
      stageChanges.add(check);
      signal.addEventListener("abort", finish, { once: true });
    });
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
    return currentVoice()?.analyser ?? null;
  },
  get viseme() {
    const source = currentVoice();
    return source?.cues?.sample(source.analyser) ?? null;
  },
  get phrase() {
    return currentVoice()?.cues?.phrase() ?? "";
  },
  get ear() {
    return state.ear?.analyser ?? null;
  },
  get mood() {
    return state.mood;
  },
};
