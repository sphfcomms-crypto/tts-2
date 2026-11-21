import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  DEFAULT_SCRIPT,
  DEFAULT_VIBE,
  DEFAULT_VOICE,
  VIBES,
  VOICES,
} from "./library";

// The on/off choices in the Settings menu.
export interface Toggles {
  // Rewrite the script in Urdu script, in a young woman's words, before it
  // is spoken. Off: it is read exactly as written.
  urduMode: boolean;
  // On a call, she says hello first instead of waiting for the caller.
  greetFirst: boolean;
  // Show what each side says during a call.
  captions: boolean;
  // Click sounds on the buttons.
  sounds: boolean;
  // Show which model handles each job.
  showEngines: boolean;
}

export interface AppState extends Toggles {
  voice: string;
  // The script to speak, and whether it differs from the opening sample.
  input: string;
  inputDirty: boolean;
  // The voice instructions, and the vibe they came from (null once edited).
  prompt: string;
  vibe: string | null;
  // The clip last made for the current script and settings, kept so it
  // can be replayed or saved without making it again. Cleared whenever
  // the script, the voice or the vibe changes.
  latestAudio: Blob | null;
  // The last text the Urdu step produced. A script equal to it is spoken
  // as it is, instead of being restyled a second time.
  styledText: string | null;
}

const DEFAULT_TOGGLES: Toggles = {
  urduMode: true,
  greetFirst: true,
  captions: true,
  sounds: true,
  showEngines: false,
};

const STORAGE_KEY = "tts-settings";
const SAVED_KEYS = [
  "voice",
  "vibe",
  "prompt",
  ...(Object.keys(DEFAULT_TOGGLES) as (keyof Toggles)[]),
] as const;

// Settings chosen earlier on this device, with anything invalid dropped.
function saved(): Partial<AppState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    const out: Partial<AppState> = {};
    if (VOICES.includes(raw.voice)) out.voice = raw.voice;
    if (typeof raw.prompt === "string" && raw.prompt.trim()) {
      out.prompt = raw.prompt.slice(0, 999);
      out.vibe = VIBES.some((v) => v.name === raw.vibe) ? raw.vibe : null;
    }
    for (const key of Object.keys(DEFAULT_TOGGLES) as (keyof Toggles)[]) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    }
    return out;
  } catch {
    return {};
  }
}

const INITIAL_STATE: AppState = {
  voice: DEFAULT_VOICE,
  input: DEFAULT_SCRIPT,
  inputDirty: false,
  prompt: DEFAULT_VIBE.prompt,
  vibe: DEFAULT_VIBE.name,
  latestAudio: null,
  styledText: null,
  ...DEFAULT_TOGGLES,
  ...saved(),
};

const store = create(immer(() => INITIAL_STATE));

// Remember the settings (not the script) for next time.
if (typeof window !== "undefined") {
  store.subscribe((state) => {
    try {
      const keep: Record<string, unknown> = {};
      for (const key of SAVED_KEYS) keep[key] = state[key];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keep));
    } catch {}
  });
}

export const appStore = {
  useState: store,
  setState: store.setState,
  getState: store.getState,
  subscribe: store.subscribe,
} as const;
