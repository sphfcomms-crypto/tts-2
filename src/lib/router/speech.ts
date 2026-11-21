import { Candidate, EngineError } from "./core";
import { OPENAI_BASE, canUse, failed, openaiHeaders } from "./engines";
import { cutWarmup, pcmToWav } from "./pcm";
import { similarity, spokenAccuracy } from "./verify";

// Speech engines, best first.
//
// 1. The conversational audio models (the family behind ChatGPT's voice).
//    They sound far more like a person than the plain TTS models. They are
//    chat models though, and can drop, swap or even add words, so every
//    piece is listened to and recorded again if it does not say the text.
//    Measured on Urdu, 12 takes each: gpt-audio-mini said the text every
//    time (94% of words back on average, worst take 83%) and is about twice
//    as fast; gpt-audio-1.5 kept adding lines of its own (87%, worst 65%).
//    So mini goes first.
// 2. The plain TTS models, which always say every word but sound flatter.
//    They are the fallback.
//
// Speech is made one piece (a sentence or two) at a time. The pieces are
// generated in parallel and played in order, so the voice starts as soon as
// the first short piece is ready instead of after the whole script.

export type SpeechRequest = {
  input: string; // the piece to speak
  prompt: string; // voice instructions
  voice: string;
  format: "pcm" | "mp3";
  // What was said just before this piece, for a consistent delivery.
  before?: string;
  // Record two takes at once and keep the first good one. Used for the
  // opening pieces, where waiting for a second try would stall playback.
  hedge?: boolean;
  // Skip the listen-back and trust the model's own transcript. Used for the
  // very first piece, where that check would delay the start of the voice.
  quickCheck?: boolean;
};

const ACTOR_MODELS = ["gpt-audio-mini", "gpt-audio-1.5"];

type TtsModel = {
  model: string;
  // Follows the vibe's voice instructions.
  instructions: boolean;
  // Voices the model does not have, and the closest one it does have.
  voiceFallback: Record<string, string>;
};

const TTS_MODELS: TtsModel[] = [
  { model: "gpt-4o-mini-tts", instructions: true, voiceFallback: {} },
  { model: "gpt-4o-mini-tts-2025-12-15", instructions: true, voiceFallback: {} },
  { model: "gpt-4o-mini-tts-2025-03-20", instructions: true, voiceFallback: {} },
  { model: "tts-1-hd", instructions: false, voiceFallback: { marin: "coral" } },
  { model: "tts-1", instructions: false, voiceFallback: { marin: "coral" } },
];

// The speech models do not have the call-only voices.
const speechVoice = (voice: string) => (voice === "nira" ? "coral" : voice);

const TIMEOUT_MS = 45_000;
const ATTEMPTS = 2;
const USABLE = 0.7; // below this after every attempt, use another engine

// The check is there to catch a take that dropped or changed a phrase, not
// one word the transcriber heard differently: a strict bar made pieces be
// recorded again for nothing, and playback stalled while they were. A short
// piece has few words, so one slip costs it more.
const goodEnough = (text: string) =>
  text.trim().split(/\s+/).length <= 6 ? 0.7 : 0.8;

// The audio models garble the first word they say: measured on its own, the
// opening word of a clip came back right about one time in three. So each
// piece is recorded with a throwaway warm-up sentence in front, which takes
// that damage, and the warm-up is cut off at the pause after it. With it,
// the first real word came back right 94% of the time.
const WARMUP_URDU = "اچھا تو اب میری بات سنو۔";
const WARMUP_ENGLISH = "Okay, so here is what I want to say.";
const warmupFor = (text: string) =>
  /[\u0600-\u06FF]/.test(text) ? WARMUP_URDU : WARMUP_ENGLISH;

const ACTOR_PROMPT =
  "You are a voice actor recording one line. Read the line in the user message aloud exactly as written: every word, in the same order, with nothing added, skipped, replaced, translated or answered. The performance notes below describe HOW to say it and are never spoken aloud. The notes may mention moods that belong to other parts of the script: never invent words to act them out, and if the line is short, the recording is short. Speak at a natural, unhurried conversational pace, like a real person and not like an announcer or a machine.";

async function act(
  model: string,
  req: SpeechRequest
): Promise<{ audio: Uint8Array; transcript: string }> {
  const warmup = req.format === "pcm" ? warmupFor(req.input) : "";
  const line = warmup ? `${warmup} ${req.input}` : req.input;
  const opening = warmup
    ? "\n\nThe line opens with a short warm-up sentence. Say it like the rest, then pause for a moment before you go on."
    : "";
  const continuity = req.before
    ? `\n\nThis line continues a speech already in progress. Keep exactly the same voice, energy and mood as the lines before it, which were (for context only, never read these aloud): "${req.before}"`
    : "";

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { ...openaiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      modalities: ["text", "audio"],
      audio: {
        voice: speechVoice(req.voice),
        format: req.format === "pcm" ? "pcm16" : "mp3",
      },
      messages: [
        {
          role: "system",
          content: `${ACTOR_PROMPT}${opening}\n\nPerformance notes: ${req.prompt}${continuity}`,
        },
        {
          role: "user",
          content: `Read this line aloud exactly:\n\n${line}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) await failed(res, model);

  const audio = (await res.json())?.choices?.[0]?.message?.audio;
  if (typeof audio?.data !== "string" || !audio.data) {
    throw new EngineError(`${model} returned no audio`);
  }
  return {
    audio: new Uint8Array(Buffer.from(audio.data, "base64")),
    transcript: String(audio.transcript ?? ""),
  };
}

type Take = {
  audio: Uint8Array;
  score: number;
  // Why a take scored low, for the log.
  note?: string;
};

// Records one take and scores how faithfully it says the text. The take is
// checked with its warm-up still on (a transcriber hears the first real word
// far better with something before it), then the warm-up is cut off.
async function scoredTake(model: string, req: SpeechRequest): Promise<Take> {
  const take = await act(model, req);
  const warmup = req.format === "pcm" ? warmupFor(req.input) : "";
  const spoken = warmup ? `${warmup} ${req.input}` : req.input;

  // The model's own transcript is free: if it already shows the line was
  // changed, there is no need to pay for a listen.
  let score = take.transcript ? similarity(spoken, take.transcript) : 1;
  if (score >= goodEnough(req.input) && !req.quickCheck) {
    try {
      score =
        req.format === "pcm"
          ? await spokenAccuracy(spoken, pcmToWav(take.audio), "wav")
          : await spokenAccuracy(spoken, take.audio, "mp3");
    } catch (err) {
      // The check itself is unavailable: keep the take rather than fail.
      console.warn("[router] could not check the clip:", err);
    }
  }

  const note = `said ${Math.round(score * 100)}%, own transcript "${take.transcript.slice(0, 70)}"`;
  if (!warmup) return { audio: take.audio, score, note };

  const audio = cutWarmup(take.audio, warmup.length, req.input.length);
  // No pause to cut at: the take cannot be used as it is.
  return audio
    ? { audio, score, note }
    : { audio: take.audio, score: 0, note: `no pause after the warm-up (${note})` };
}

// Two takes at once: resolves with the first one that is good, or with the
// better of the two when neither is.
function hedgedTake(model: string, req: SpeechRequest): Promise<Take> {
  const target = goodEnough(req.input);
  return new Promise((resolve, reject) => {
    const done: Take[] = [];
    let failures = 0;
    let settled = false;
    const finish = () => {
      if (settled || done.length + failures < 2) return;
      settled = true;
      if (!done.length) reject(new EngineError(`${model} produced no take`));
      else resolve(done.sort((a, b) => b.score - a.score)[0]);
    };
    for (let i = 0; i < 2; i++) {
      scoredTake(model, req)
        .then((take) => {
          if (take.score >= target && !settled) {
            settled = true;
            resolve(take);
          }
          done.push(take);
        })
        .catch((err) => {
          failures += 1;
          if (failures === 2 && !settled) {
            settled = true;
            reject(err);
          }
        })
        .finally(finish);
    }
  });
}

// Records the piece, listens to it, and tries again if a phrase went wrong.
// Returns the most faithful take, or fails so the router uses another engine.
async function actVerified(model: string, req: SpeechRequest) {
  const target = goodEnough(req.input);
  let best: Take | null = null;

  if (req.hedge) {
    best = await hedgedTake(model, req);
  } else {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const take = await scoredTake(model, req);
      if (!best || take.score > best.score) best = take;
      if (take.score >= target) break;
      console.log(
        `[router] ${model} take ${attempt} said ${Math.round(
          take.score * 100
        )}% of "${req.input.slice(0, 30)}…"`
      );
    }
  }

  if (!best || best.score < USABLE) {
    // 422: this piece went wrong, not the engine. The router tries the next
    // engine for the piece without putting this one to rest.
    throw new EngineError(
      `${model} did not say "${req.input.slice(0, 30)}…": ${
        best?.note ?? "no take"
      }`,
      422
    );
  }
  return best.audio;
}

// Each candidate resolves to the audio of one piece: raw PCM or MP3 bytes.
export function speechEngines(req: SpeechRequest): Candidate<Uint8Array>[] {
  const actors: Candidate<Uint8Array>[] = ACTOR_MODELS.map((model) => ({
    id: `speech:${model}`,
    label: model,
    available: () => canUse(model),
    run: () => actVerified(model, req),
  }));

  const tts: Candidate<Uint8Array>[] = TTS_MODELS.map(
    ({ model, instructions, voiceFallback }) => ({
      id: `speech:${model}`,
      label: model,
      available: () => canUse(model),
      run: async () => {
        const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
          method: "POST",
          headers: { ...openaiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: req.input,
            response_format: req.format,
            voice:
              voiceFallback[speechVoice(req.voice)] ?? speechVoice(req.voice),
            ...(instructions && req.prompt && { instructions: req.prompt }),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) await failed(res, model);
        const audio = new Uint8Array(await res.arrayBuffer());
        if (!audio.length) throw new EngineError(`${model} returned no audio`);
        return audio;
      },
    })
  );

  return [...actors, ...tts];
}

// Minimum characters per piece. The first is short so the voice starts
// fast, the second a little longer, the rest longer still for a steadier
// delivery and fewer joins.
const FIRST_PIECE_MIN = 12;
const SECOND_PIECE_MIN = 40;
const PIECE_MIN = 70;
const PIECE_MAX = 240;

export type Piece = { text: string; paragraphEnd: boolean };

// Splits a script into pieces at sentence ends. The first piece is kept
// short; the rest are a sentence or two each.
export function splitForSpeech(script: string): Piece[] {
  const pieces: Piece[] = [];

  const paragraphs = script
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    // A sentence runs up to and including its closing punctuation.
    const sentences = paragraph.match(/[^۔؟?!.…]+[۔؟?!.…]*["”'’)]*\s*/g) ?? [
      paragraph,
    ];

    let current = "";
    const flush = () => {
      if (current.trim()) {
        pieces.push({ text: current.trim(), paragraphEnd: false });
      }
      current = "";
    };

    for (const sentence of sentences) {
      if (current && current.length + sentence.length > PIECE_MAX) flush();
      current += sentence;
      const minimum =
        pieces.length === 0
          ? FIRST_PIECE_MIN
          : pieces.length === 1
          ? SECOND_PIECE_MIN
          : PIECE_MIN;
      if (current.trim().length >= minimum) flush();
    }

    // A leftover too short to stand alone joins the piece before it.
    const rest = current.trim();
    const previous = pieces[pieces.length - 1];
    if (
      rest &&
      rest.length < FIRST_PIECE_MIN &&
      previous &&
      !previous.paragraphEnd
    ) {
      previous.text += " " + rest;
      current = "";
    }
    flush();

    if (pieces.length) pieces[pieces.length - 1].paragraphEnd = true;
  }

  return pieces;
}
