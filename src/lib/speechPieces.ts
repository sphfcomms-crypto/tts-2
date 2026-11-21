import { GIRL_VOICE_REMINDER, GIRL_VOICE_RULE, VOICES } from "@/lib/library";
import { MAX_INPUT_LENGTH, MAX_PROMPT_LENGTH } from "@/lib/limits";
import { route } from "@/lib/router/core";
import { hasOpenAI } from "@/lib/router/engines";
import { Piece, speechEngines, splitForSpeech } from "@/lib/router/speech";

// Speaking a script piece by piece (used by /api/generate).

const PARALLEL = 4; // pieces generated at the same time
const HEDGED_PIECES = 2; // opening pieces recorded twice at once
const CONTEXT_CHARS = 220; // how much earlier text a piece is shown
export const SENTENCE_GAP_MS = 230;
export const PARAGRAPH_GAP_MS = 480;

export type Made = { ok: true; audio: Uint8Array; engine: string } | { ok: false };

// Checks a request and splits its script. Returns a ready error response
// when it cannot be spoken.
export function readSpeechRequest(params: {
  input: string;
  prompt: string;
  voice: string;
}): { error: Response } | { pieces: Piece[]; prompt: string } {
  // The frontend keeps to the length limit, but it is applied here too.
  // […] marks a word that could not be read off a damaged page: the voice
  // pauses there instead of trying to say it.
  const input = params.input.slice(0, MAX_INPUT_LENGTH).replaceAll("[…]", "…");

  // Every vibe is spoken by a young woman, whatever its own instructions
  // say: the rule goes before the vibe and is repeated after it.
  const vibePrompt = params.prompt.slice(0, MAX_PROMPT_LENGTH).trim();
  const prompt = vibePrompt
    ? `${GIRL_VOICE_RULE}\n\n${vibePrompt}\n\n${GIRL_VOICE_REMINDER}`
    : GIRL_VOICE_RULE;

  // Only the young female voices are accepted.
  if (!VOICES.includes(params.voice)) {
    return { error: new Response("Invalid voice", { status: 400 }) };
  }
  if (!hasOpenAI()) {
    return {
      error: new Response("OPENAI_API_KEY is not set in .env", { status: 401 }),
    };
  }
  const pieces = splitForSpeech(input);
  if (!pieces.length) {
    return { error: new Response("Empty input", { status: 400 }) };
  }
  return { pieces, prompt };
}

// Starts the pieces, a few at a time, in order. For each piece the router
// picks the speech model and fails over to the next one if needed. Each
// result settles and never rejects, so a later piece failing cannot crash a
// stream while an earlier one is still being sent.
export function makeSpeech(
  pieces: Piece[],
  options: { prompt: string; voice: string; format: "pcm" | "mp3" }
) {
  // One result per piece, filled in as each is made. They can be awaited in
  // any order, before the piece has even been started.
  const settle: ((made: Made) => void)[] = [];
  const results = pieces.map(
    () => new Promise<Made>((resolve) => settle.push(resolve))
  );
  let next = 0;
  const startNext = () => {
    if (next >= pieces.length) return;
    const index = next++;
    const before = pieces
      .slice(0, index)
      .map((p) => p.text)
      .join(" ")
      .slice(-CONTEXT_CHARS);
    route(
      "speech",
      speechEngines({
        input: pieces[index].text,
        prompt: options.prompt,
        voice: options.voice,
        format: options.format,
        before: before || undefined,
        hedge: index < HEDGED_PIECES,
        quickCheck: index === 0,
      })
    )
      .then(
        ({ value, engine }): Made => ({
          ok: true,
          audio: value,
          engine: engine.label,
        })
      )
      .catch((err): Made => {
        console.error("Error generating speech:", err);
        return { ok: false };
      })
      .then((made) => {
        settle[index](made);
        startNext();
      });
  };
  for (let i = 0; i < PARALLEL; i++) startNext();

  return {
    // Piece i, once it has been made.
    piece: (i: number): Promise<Made> => results[i],
  };
}
