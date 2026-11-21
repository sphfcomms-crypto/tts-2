import { Candidate, route } from "./core";
import { OPENAI_BASE, canUse, failed, openaiHeaders } from "./engines";
import { hasDevanagari, toUrduScript } from "./urdu";

// Quality gate for generated speech: listen to the audio with a transcriber
// and measure how much of the intended text comes back. A clip in which
// words were dropped, swapped or garbled scores low and is generated again.
// The transcriber forgives small slips, so this catches wrong or missing
// words, not a slightly off accent.

const CHECK_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

const URDU_LETTER = /[؀-ۿ]/;

function listeners(
  audio: Uint8Array,
  format: "wav" | "mp3",
  language: string | null
): Candidate<string>[] {
  return CHECK_MODELS.map((model) => ({
    id: `check:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () => {
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "json");
      if (language) form.append("language", language);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], {
          type: format === "wav" ? "audio/wav" : "audio/mpeg",
        }),
        `clip.${format}`
      );
      const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: openaiHeaders(),
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) await failed(res, model);
      return String((await res.json()).text ?? "").trim();
    },
  }));
}

function words(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/[ً-ْٰـ]/g, "") // zer, zabar, pesh, tatweel
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ں/g, "") // ہوں / ہو: the nasal ending is often not written
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^ا+و?ف+$/.test(word) ? "اف" : word)); // اُف / اوف / افف
}

// Share of the words the two texts have in common, in order (0 to 1). It is
// measured against the longer text, so words that were added count against
// a take just as much as words that were dropped.
export function similarity(expected: string, heard: string): number {
  const a = words(expected);
  const b = words(heard);
  if (!a.length || !b.length) return 0;

  // Longest common subsequence of words.
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

// How faithfully the audio says the expected text (0 to 1).
export async function spokenAccuracy(
  expected: string,
  audio: Uint8Array,
  format: "wav" | "mp3"
): Promise<number> {
  const urdu = URDU_LETTER.test(expected);
  let { value: heard } = await route(
    "check",
    listeners(audio, format, urdu ? "ur" : null)
  );
  // The transcriber sometimes writes Urdu speech in Devanagari; compare
  // like with like.
  if (urdu && hasDevanagari(heard)) {
    heard = await toUrduScript(heard);
  }
  return similarity(expected, heard);
}
