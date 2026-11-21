import { NextRequest } from "next/server";
import { gpuHealth, gpuSpeak, gpuSpeakKept } from "@/lib/avatarGpu";
import { pcmToWav, silence, trimSilence } from "@/lib/router/pcm";
import {
  PARAGRAPH_GAP_MS,
  SENTENCE_GAP_MS,
  makeSpeech,
  readSpeechRequest,
} from "@/lib/speechPieces";
import { overLimit } from "@/lib/usage";

// Her speaking the script, on video.
//
//   POST /api/avatar/speak   (form: input, prompt, voice)
//
// The voice is made exactly as for /api/generate, piece by piece. Each
// piece then goes to the GPU box, which returns a short video of her saying
// it (her voice inside it). The pieces are sent to the browser in order as
// they are ready, each one as: 4 bytes holding its length, then the video.
// The browser joins them into one continuous video.
//
// With the form field direct=1 the videos do not pass through here at all:
// the GPU box keeps each one, and the answer is a line of JSON per piece,
// {"id": …}, in order. The browser fetches each from the box itself
// (GET <box>/piece/<id>), which is much faster than through this app.
//
// If the GPU box is not there, or fails before the first piece, the answer
// is an error and the page plays the voice alone instead.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params = {
    input: form.get("input")?.toString() || "",
    prompt: form.get("prompt")?.toString() || "",
    voice: form.get("voice")?.toString() || "",
  };
  const direct = form.get("direct")?.toString() === "1";
  const ready = readSpeechRequest(params);
  if ("error" in ready) return ready.error;
  const { pieces } = ready;

  if (!(await gpuHealth())) {
    return new Response("The avatar GPU is not running.", { status: 503 });
  }

  const limited = overLimit("speech", req);
  if (limited) return limited;

  const speech = makeSpeech(pieces, {
    prompt: ready.prompt,
    voice: params.voice,
    format: "pcm",
  });

  // The voice pieces are made in parallel; the video is made one piece
  // after another, because each has to know where her movement stopped in
  // the one before.
  let engine = "";
  let at: Promise<number | null> = Promise.resolve(0);
  const videos = pieces.map((piece, i) => {
    const startAt = at;
    const video = (async (): Promise<{ video: Uint8Array; next: number } | null> => {
      const encoder = new TextEncoder();
      const [start, made] = await Promise.all([startAt, speech.piece(i)]);
      if (start === null || !made.ok || req.signal.aborted) return null;
      if (i === 0) engine = made.engine;
      const gap =
        i < pieces.length - 1
          ? silence(piece.paragraphEnd ? PARAGRAPH_GAP_MS : SENTENCE_GAP_MS)
          : silence(120);
      try {
        const wav = pcmToWav(concat(trimSilence(made.audio), gap));
        if (direct) {
          const kept = await gpuSpeakKept(wav, start, req.signal);
          return {
            video: encoder.encode(JSON.stringify({ id: kept.id }) + "\n"),
            next: kept.next,
          };
        }
        return await gpuSpeak(wav, start, { signal: req.signal });
      } catch (err) {
        if (!req.signal.aborted) console.error("Avatar video failed:", err);
        return null;
      }
    })();
    at = video.then((result) => (result ? result.next : null));
    return video.then((result) => result?.video ?? null);
  });

  // Nothing is sent until the first piece exists, so a failure is still a
  // proper error and the page can fall back to the voice alone.
  const first = await videos[0];
  if (!first) {
    return new Response("Could not make the video.", { status: 502 });
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const next of videos) {
          const video = await next;
          if (!video || req.signal.aborted) break;
          if (!direct) {
            const length = new Uint8Array(4);
            new DataView(length.buffer).setUint32(0, video.length);
            controller.enqueue(length);
          }
          controller.enqueue(video);
        }
      } catch (err) {
        if (!(err instanceof TypeError)) {
          console.error("Avatar stream stopped:", err);
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": direct ? "application/x-ndjson" : "application/octet-stream",
      // no-transform keeps the server from holding the stream back to gzip it.
      "Cache-Control": "no-cache, no-transform",
      "X-Speech-Engine": engine,
    },
  });
}
