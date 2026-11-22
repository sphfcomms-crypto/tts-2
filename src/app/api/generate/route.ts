import { NextRequest, userAgent } from "next/server";
import { PCM_RATE, silence, trimSilence, wavHeader } from "@/lib/router/pcm";
import {
  PARAGRAPH_GAP_MS,
  SENTENCE_GAP_MS,
  makeSpeech,
  readSpeechRequest,
} from "@/lib/speechPieces";
import { frameHeader, PIECE_MEDIA_TYPE } from "@/lib/speechFrames";
import { overLimit } from "@/lib/usage";

// Generates the speech and streams it back. The script is spoken in pieces
// that are generated in parallel and sent in order, so the voice starts
// once the first short piece is ready. For each piece the router picks the
// speech model and fails over to the next one if needed.
async function speak(
  req: NextRequest,
  params: { input: string; prompt: string; voice: string; vibe: string }
) {
  const ua = userAgent(req);
  const framed = req.headers.get("accept") === PIECE_MEDIA_TYPE;
  const format = framed || ua.engine?.name === "Blink" ? "wav" : "mp3";

  const { voice, vibe } = params;
  const ready = readSpeechRequest(params);
  if ("error" in ready) return ready.error;
  const { pieces } = ready;

  const limited = overLimit("speech", req);
  if (limited) return limited;

  const speech = makeSpeech(pieces, {
    prompt: ready.prompt,
    voice,
    format: format === "wav" ? "pcm" : "mp3",
  });

  // Nothing is sent until the first piece exists, so a total failure is
  // still a proper error response.
  const first = await speech.piece(0);
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
          const piece = await speech.piece(i);
          if (!piece.ok || req.signal.aborted) {
            if (framed) throw new Error("A speech phrase could not be completed.");
            break;
          }

          if (format === "wav") {
            const pcm = trimSilence(piece.audio);
            const pauseMs = pieces[i].paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS;
            const gap = i === pieces.length - 1 ? 0 : pauseMs;
            if (framed) {
              const phrase = pieces[i].text;
              if (!pcm.length && /[\p{L}\p{N}]/u.test(phrase)) {
                throw new Error("A speech phrase contained no audible samples.");
              }
              const text = new TextEncoder().encode(phrase);
              const gapSamples = Math.round(gap * PCM_RATE / 1000);
              controller.enqueue(frameHeader(text.length, pcm.length, gapSamples));
              controller.enqueue(text);
            }
            if (pcm.length) controller.enqueue(pcm);
            if (!framed && gap) controller.enqueue(silence(gap));
          } else {
            controller.enqueue(piece.audio);
          }
        }
        if (framed) controller.enqueue(frameHeader(0, 0, 0));
      } catch (err) {
        if (framed) controller.error(err);
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
      "Content-Type": framed ? PIECE_MEDIA_TYPE : format === "wav" ? "audio/wav" : "audio/mpeg",
      ...(!framed && { "Content-Disposition": `inline; filename="${filename}"` }),
      "Vary": "Accept, User-Agent",
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
