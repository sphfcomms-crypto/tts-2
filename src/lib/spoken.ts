import { DEFAULT_SCRIPT } from "./library";
import { appStore } from "./store";
import { toUrduScript } from "./script";

// True when the script is the user's own text that the Urdu step has not
// worked on yet: not the untouched sample, and not its own earlier output.
export function needsUrduStep(state: {
  urduMode: boolean;
  input: string;
  styledText: string | null;
}): boolean {
  return (
    state.urduMode &&
    state.input.trim().length > 0 &&
    state.input !== DEFAULT_SCRIPT &&
    state.input !== state.styledText
  );
}

// The text to send to the speech model. In Urdu mode the user's own text
// (typed in Roman or Urdu, or dictated) is first rewritten in Urdu script
// in the young woman's voice; if that fails it is spoken as written.
export async function spokenText(): Promise<string> {
  const state = appStore.getState();
  if (!needsUrduStep(state)) return state.input;
  return (await toUrduScript(state.input, true)).text;
}
