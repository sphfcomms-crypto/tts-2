import { FPS, speechGesture, type Unit } from "./director";

export type ScriptShot = { clip: string; frame: number; frames: number };

const QUIET = ["listen_still", "listen_breath", "listen_nod", "listen_smile"];
const LOW_KEY = ["talk_right", "listen_nod", "listen_breath", "listen_smile"];
const EMPHASIS = ["talk_open", "talk_both"];

// A unit finishes in the common seated pose. Only switch source pictures
// there, even when a network chunk or a spoken sentence ends earlier.
export function scriptedShots(
  pcm: Float32Array, rate: number, units: readonly Unit[], first: Unit,
  phraseAt: (seconds: number) => string,
): ScriptShot[] {
  const total = Math.ceil(pcm.length * FPS / rate);
  if (!total) return [];
  if (total <= first.frames || units.length === 1) {
    return [{ clip: first.name, frame: 0, frames: total }];
  }

  const levels = new Float32Array(total);
  let peak = 0;
  for (let frame = 0; frame < total; frame++) {
    const from = Math.round(frame * rate / FPS);
    const to = Math.min(pcm.length, Math.round((frame + 1) * rate / FPS));
    let power = 0;
    for (let i = from; i < to; i++) power += pcm[i] * pcm[i];
    levels[frame] = Math.sqrt(power / Math.max(1, to - from));
    peak = Math.max(peak, levels[frame]);
  }

  const shots: ScriptShot[] = [];
  const lastUsed = new Map<string, number>();
  let accentAt = -3;
  let lastAccentPhrase = "";
  for (let frame = 0; frame < total;) {
    // Read the part of the recording when the next movement will unfold.
    // Count phrases only on voiced frames, so a comma or an inserted pause
    // cannot suggest a gesture from an adjacent, inaudible sentence.
    const end = Math.min(total, frame + Math.round(1.6 * FPS));
    const phrases = new Map<string, number>();
    let voiced = 0, level = 0, dominant = "";
    for (let i = frame; i < end; i++) {
      if (levels[i] <= Math.max(0.002, peak * 0.06)) continue;
      voiced++;
      level += levels[i];
      const phrase = phraseAt((i + 0.5) / FPS);
      if (!phrase) continue;
      phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
      if (phrases.get(phrase)! > (phrases.get(dominant) ?? 0)) dominant = phrase;
    }

    const previous = shots[shots.length - 1]?.clip;
    const available = units.filter(unit => unit.name !== previous);
    // Within a group favour the gesture she used least recently.
    function choose(names: readonly string[]) {
      return available.filter(unit => names.includes(unit.name)).sort((a, b) =>
        (lastUsed.get(a.name) ?? -1) - (lastUsed.get(b.name) ?? -1) ||
        names.indexOf(a.name) - names.indexOf(b.name))[0];
    }
    const quiet = voiced < (end - frame) / 4 || total - frame < FPS;
    const cue = speechGesture(dominant);
    const allowAccent = !quiet && shots.length - accentAt >= 2;
    let unit = allowAccent && dominant !== lastAccentPhrase && (cue !== "greet" || frame === 0)
      ? choose([cue]) : undefined;
    if (!unit && !shots.length && !quiet) unit = first;
    if (!unit && allowAccent && shots.length - accentAt >= 3 && level > voiced * peak * 0.45) {
      unit = choose(EMPHASIS);
    }
    if (unit && (unit.name === cue || EMPHASIS.includes(unit.name))) {
      accentAt = shots.length;
      lastAccentPhrase = dominant;
    }
    unit ??= choose(quiet ? QUIET : LOW_KEY) ?? choose(QUIET) ?? available[0] ?? first;
    const frames = Math.min(unit.frames, total - frame);
    lastUsed.set(unit.name, shots.length);
    shots.push({ clip: unit.name, frame, frames });
    frame += frames;
  }
  return shots;
}
