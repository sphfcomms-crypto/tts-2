import { NextRequest, userAgent } from "next/server";
import {
  GIRL_VOICE_REMINDER,
  GIRL_VOICE_RULE,
  VOICES,
} from "@/lib/library";
import { route } from "@/lib/router/core";
import { MAX_INPUT_LENGTH, MAX_PROMPT_LENGTH } from "@/lib/limits";
import { hasOpenAI } from "@/lib/router/engines";
import { silence, trimSilence, wavHeader } from "@/lib/router/pcm";
import { Piece, speechEngines, splitForSpeech } from "@/lib/router/speech";
import { overLimit } from "@/lib/usage";


const PARALLEL = 4; // pieces generated at the same time
const HEDGED_PIECES = 2; // opening pieces recorded twice at once
const SENTENCE_GAP_MS = 230;
const PARAGRAPH_GAP_MS = 480;
const CONTEXT_CHARS = 220; // how much earlier text a piece is shown

type Made = { ok: true; audio: Uint8Array; engine: string } | { ok: false };

// Generates the speech and streams it back. The script is spoken in pieces
// that are generated in parallel and sent in order, so the voice starts
// once the first short piece is ready. For each piece the router picks the
// speech model and fails over to the next one if needed.
async function speak(
  req: NextRequest,
  params: { input: string; prompt: string; voice: string; vibe: string }
) {
  const ua = userAgent(req);
  const format = ua.engine?.name === "Blink" ? "wav" : "mp3";

  // Truncate input and prompt to max 1000 characters
  // Frontend handles this, but we'll do it here too
  // to avoid extra requests to the server
  const input = params.input.slice(0, MAX_INPUT_LENGTH);
  const { voice, vibe } = params;

  // Every vibe is spoken by a young woman, whatever its own instructions
  // say: the rule goes before the vibe and is repeated after it.
  const vibePrompt = params.prompt.slice(0, MAX_PROMPT_LENGTH).trim();
  const prompt = vibePrompt
    ? `${GIRL_VOICE_RULE}\n\n${vibePrompt}\n\n${GIRL_VOICE_REMINDER}`
    : GIRL_VOICE_RULE;

  // Only the young female voices are accepted.
  if (!VOICES.includes(voice)) {
    return new Response("Invalid voice", { status: 400 });
  }
  if (!hasOpenAI()) {
    return new Response("OPENAI_API_KEY is not set in .env", { status: 401 });
  }

  const pieces: Piece[] = splitForSpeech(input);
  if (!pieces.length) {
    return new Response("Empty input", { status: 400 });
  }

  const limited = overLimit("speech", req);
  if (limited) return limited;

  // Start the pieces, a few at a time, in order. Each promise settles to a
  // result and never rejects, so a later piece failing cannot crash the
  // stream while an earlier one is still being sent.
  const made: Promise<Made>[] = [];
  let next = 0;
  const startNext = () => {
    if (next >= pieces.length) return;
    const index = next++;
    const before = pieces
      .slice(0, index)
      .map((p) => p.text)
      .join(" ")
      .slice(-CONTEXT_CHARS);
    made[index] = route(
      "speech",
      speechEngines({
        input: pieces[index].text,
        prompt,
        voice,
        format: format === "wav" ? "pcm" : "mp3",
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
      .finally(startNext);
  };
  for (let i = 0; i < PARALLEL; i++) startNext();

  // Nothing is sent until the first piece exists, so a total failure is
  // still a proper error response.
  const first = await made[0];
  if (!first.ok) {
    return new Response("An error occurred while generating the audio.", {
      status: 502,
    });
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (format === "wav") controller.enqueue(wavHeader());

        for (let i = 0; i < pieces.length; i++) {
          // made[i] exists by now: pieces start in order, and each one that
          // finishes starts the next.
          while (!made[i]) await made[i - 1];
          const piece = await made[i];
          if (!piece.ok || req.signal.aborted) break;

          if (format === "wav") {
            controller.enqueue(trimSilence(piece.audio));
            if (i < pieces.length - 1) {
              controller.enqueue(
                silence(
                  pieces[i].paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS
                )
              );
            }
          } else {
            controller.enqueue(piece.audio);
          }
        }
      } catch (err) {
        if (!(err instanceof TypeError)) {
          console.error("Speech stream stopped:", err);
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  const filename = `tts-${voice}-${vibe}.${format}`;

  return new Response(body, {
    headers: {
      "Content-Type": format === "wav" ? "audio/wav" : "audio/mpeg",
      "Content-Disposition": `inline; filename="${filename}"`,
      // no-transform keeps the server from gzipping the stream, which held
      // the first audio back until several seconds of it had piled up.
      "Cache-Control": "no-cache, no-transform",
      "X-Speech-Engine": first.engine,
    },
  });
}

// GET handler that proxies requests to the OpenAI TTS API and streams
// the response back to the client.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  return speak(req, {
    input: searchParams.get("input") || "",
    prompt: searchParams.get("prompt") || "",
    voice: searchParams.get("voice") || "",
    vibe: searchParams.get("vibe") || "audio",
  });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  return speak(req, {
    input: formData.get("input")?.toString() || "",
    prompt: formData.get("prompt")?.toString() || "",
    voice: formData.get("voice")?.toString() || "",
    vibe: formData.get("vibe")?.toString() || "audio",
  });
}
