import type { TranscriptSpan } from "../callTurns";

export type FilmCue = "explain" | "reflect" | "ask" | "warm" | "emphasize";
export type CallGesture = FilmCue | "count" | "greet";
export type GestureCue = { role: CallGesture; clause: number };

function words(text: string) {
  return " " + text.toLowerCase().normalize("NFKC")
    .replace(/[\u0640\u064b-\u065f\u0670]/g, "").replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim() + " ";
}

function meaning(text: string, caller = false): CallGesture | undefined {
  const w = words(text);
  if (/ (?:pehl[aeiy]|pehle|phir|do cheezen|steps?|first|second|پہلے|پہلی|دوسرا|دوسری|پھر|دو چیزیں|पहले|पहली|दूसरा|दूसरी|फिर|दो चीज़ें) /.test(w)) return "count";
  if (/ (?:udaas|udas|afsos|afsoos|dukhi|bura lag\p{L}*|khali ho gaya|khaali ho gaya|ghabra\p{L}*|pareshan|fik[ar]+|tension|stress\p{L}*|nervous|upset|worried|افسوس|اداس|دکھ|پریشان|گھبرا\p{L}*|فکر|سمجھ سکتی|برا لگ\p{L}*|उदास|दुखी|बुरा लग[\p{L}\p{M}]*|घबरा[\p{L}\p{M}]*|परेशान|चिंता|फिक्र|फ़िक्र) /u.test(w)) return "reflect";
  if (/ (?:zaroori|zaruri|sab se aham|bilkul|important|especially|ضروری|اہم|بالکل|خاص بات|ज़रूरी|जरूरी|अहम|बिलकुल|बिल्कुल) /.test(w)) return "emphasize";
  if (/ (?:mubarak|shabash|shukriya|shukria|khushi|great|wonderful|congratulations|thanks|thank you|مبارک|شاباش|شکریہ|خوشی|शुक्रिया|खुशी|ख़ुशी|शाबाश|मुबारक) /.test(w)) return "warm";
  if (/ (?:shayad|shaayad|soch|pata nahi|maybe|perhaps|شاید|سوچ|پتہ نہیں|پتا نہیں|शायद|पता नहीं) /.test(w)) return "reflect";
  if (!caller && /^ (?:assal\p{L}*|salaa?m|hello|hi|ال?سلام|سلام|وعلیکم) /u.test(w)) return "greet";
  if (/[؟?]\s*$/.test(text) || / (?:kya|kaise|kaisa|kaisi|kyun|why|how|what|کیا|کیسے|کیسا|کیسی|کیوں|क्या|कैसे|क्यों|कैसा|कैसी) /.test(w)) return caller ? "explain" : "ask";
  if (/ (?:misal|example|matlab|explain|samjh\p{L}*|سمجھا\p{L}*|مثال|مطلب|मतलब|मिसाल|समझा[\p{L}\p{M}]*) /u.test(w)) return "explain";
}

// A call owns its transcript clock, microphone context and received PCM. This
// object never reads displayed subtitles or the Play button's current phrase.
export class CallGestures {
  private fragments: { text: string; start: number; end: number }[] = [];
  private text = "";
  private firstStamp: number | null = null;
  private onset: number | null = null;
  private lastSound = -Infinity;
  private lastObserved = 0;
  private beats: { at: number; until: number; level: number }[] = [];
  private callerText = "";
  private lastSent: GestureCue | null = null;
  private listening = false;

  clearReply() {
    this.fragments = [];
    this.text = "";
    this.firstStamp = this.onset = null;
    this.lastSound = -Infinity;
    this.beats = [];
    this.lastSent = null;
  }

  caller(delta: string) {
    if (!this.listening) { this.clearReply(); this.callerText = ""; }
    this.listening = true;
    this.callerText = (this.callerText + delta).slice(-800);
  }

  clearCaptions() {
    // An output fragment after a long pause can start a fresh transcript
    // after its first sound has already arrived on the independent track.
    const currentBeat = this.beats.at(-1);
    this.clearReply();
    if (currentBeat && this.lastObserved - currentBeat.until < .25) {
      this.onset = currentBeat.at;
      this.beats.push(currentBeat);
      this.lastSound = currentBeat.until;
    }
  }

  update(text: string, span?: TranscriptSpan) {
    if (!text.startsWith(this.text)) this.clearCaptions();
    const delta = text.slice(this.text.length);
    if (!delta) return;
    this.text = text;
    this.listening = false;
    const age = this.onset === null ? 0 : Math.max(0, this.lastObserved - this.onset);
    if (span) this.firstStamp ??= span.startMs;
    const start = span ? (span.startMs - this.firstStamp!) / 1000 : age;
    const end = span ? (span.endMs - this.firstStamp!) / 1000 : start;
    this.fragments.push({ text: delta, start, end });
  }

  hear(at: number, duration: number, rms: number, loud: boolean) {
    this.lastObserved = at + duration;
    if (!loud) return;
    this.onset ??= at;
    if (at - this.lastSound >= .24) this.beats.push({ at, until: at + duration, level: rms });
    else {
      const beat = this.beats[this.beats.length - 1];
      beat.until = at + duration;
      if (at - beat.at < .16) beat.level = Math.max(beat.level, rms);
    }
    this.lastSound = at + duration;
  }

  // Called before reserving a body frame. A future caption cannot select
  // the current clause. Within a multiword delta only its due prefix is used.
  cue(at: number, startLine = false, greeting = false): GestureCue | null {
    if (this.onset === null || at < this.onset - .025) return null;
    const relative = at - this.onset + .16;
    let text = "";
    for (const f of this.fragments) {
      if (f.start > relative) break;
      if (f.end <= relative || f.end <= f.start) text += f.text;
      else {
        const n = Math.ceil(f.text.length * (relative - f.start) / (f.end - f.start));
        text += f.text.slice(0, n).replace(/\p{L}+$/u, "");
        break;
      }
    }
    const clauses = text.match(/[^.!?؟۔;؛\n]+[.!?؟۔;؛]?/gu)?.filter(c => c.trim()) ?? [];
    const clause = Math.max(0, clauses.length - 1);
    let beat: { at: number; until: number; level: number } | undefined;
    for (const b of this.beats) { if (b.at > at + .025) break; beat = b; }
    if (!beat || at > beat.until + .08) return null;
    const known = meaning(clauses.at(-1) ?? "");
    // The caller's words guide the first reaction while the assistant's
    // words are in flight. Later pauses can support an understated beat.
    const role = known ?? (clause === 0 ? meaning(this.callerText, true) : undefined) ??
      (greeting && !this.callerText ? "greet" : beat.level >= .055 ? "explain" : "reflect");
    const old = this.lastSent;
    if (!startLine && old && old.clause === clause) {
      if (old.role === role || !known) return null;
      // A late caption can refine the same onset, or the next genuine
      // pause. It cannot cut a hand movement mid-word.
      if (!beat || at - beat.at > .65) return null;
    }
    const result = { role, clause };
    this.lastSent = result;
    return result;
  }
}

export function callUnitNames(role: CallGesture, film: boolean): string[] {
  const preferred: Record<CallGesture, string[]> = {
    count: ["talk_count", "talk_right"], explain: ["talk_right", "talk_open"],
    reflect: ["talk_right", "talk_lean"], ask: ["talk_lean", "talk_open"],
    warm: ["talk_chest", "talk_open"], emphasize: ["talk_both", "talk_open"], greet: ["greet", "talk_open"],
  };
  if (!film) return preferred[role];
  const cue = role === "count" ? "explain" : role === "greet" ? "warm" : role;
  return [cue, "reflect", "explain"];
}
