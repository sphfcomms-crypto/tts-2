// True when the text has words typed in Latin letters (Roman Urdu, Hinglish
// or English), i.e. something the Roman-to-Urdu step has work to do on.
export const hasRomanWords = (text: string): boolean =>
  /[A-Za-z]{2,}/.test(text);

const URDU_LETTER = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN_LETTER = /[A-Za-z]/g;

// Share of the letters that are Urdu-script, from 0 to 1.
export const urduShare = (text: string): number => {
  const urdu = text.match(URDU_LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return urdu + latin === 0 ? 0 : urdu / (urdu + latin);
};

// Asks the server to rewrite Roman Urdu as Urdu script. Never throws: when
// the step fails the original text comes back with ok: false, so audio can
// still be generated from what the user typed.
export async function toUrduScript(
  input: string,
  restyle = false
): Promise<{ text: string; ok: boolean }> {
  try {
    const res = await fetch("/api/urdu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, restyle }),
    });
    if (!res.ok) {
      return { text: input, ok: false };
    }
    const data = await res.json();
    return typeof data.urdu === "string" && data.urdu
      ? { text: data.urdu, ok: true }
      : { text: input, ok: false };
  } catch (err) {
    console.error("Roman Urdu conversion failed:", err);
    return { text: input, ok: false };
  }
}
