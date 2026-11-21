// What the avatar needs to know about the rest of the app, kept outside
// React: the render loop reads it sixty times a second.
//
//   voice  her voice as it is being played (Play button or live call)
//   ear    the caller's microphone during a live call
//   mood   what she is doing when she is not speaking

export type Mood = "idle" | "thinking" | "listening";

// The photo-real avatar on screen.
//
// Underneath, a loop of her listening always runs (`base`). It is the very
// clip the GPU draws her speaking on, so a frame of her speaking and the
// frame of the loop with the same number show the same pose, and the two
// can be swapped without a jump.
export type Stage = {
  // Her talking video plays in this element.
  video: HTMLVideoElement;
  // Brings the talking video to the front, or lets the loop show again.
  speaking: (on: boolean) => void;
  // The listening loop.
  base: HTMLVideoElement;
  // While her talking video plays a script from its first frame, keeps the
  // loop underneath on the same frame, so she is in the same pose when the
  // talking stops.
  follow: (on: boolean) => void;
};

export const FRAMES_PER_SECOND = 25;

// Which frame of the listening loop will be showing `ahead` seconds from
// now. The GPU is asked to draw her speaking from that frame on.
export function loopFrame(base: HTMLVideoElement, ahead = 0): number {
  const length = Math.round((base.duration || 0) * FRAMES_PER_SECOND);
  if (!length) return 0;
  const frame = Math.round((base.currentTime + ahead) * FRAMES_PER_SECOND);
  return ((frame % length) + length) % length;
}

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
