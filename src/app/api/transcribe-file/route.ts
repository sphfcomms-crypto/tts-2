import { NextRequest } from "next/server";
import { MAX_INPUT_LENGTH, MAX_UPLOAD_BYTES } from "@/lib/limits";
import { EngineError, route } from "@/lib/router/core";
import { hasOpenAI } from "@/lib/router/engines";
import { fileCandidates } from "@/lib/router/transcribe";
import { toUrduScript } from "@/lib/router/urdu";
import { overLimit } from "@/lib/usage";

// Turns an uploaded voice recording into text.
//
//   POST /api/transcribe-file   (multipart form, field "file") -> { text, truncated }
//
// The router picks the transcription model and fails over between models.
// The text comes back in Urdu script, like everything else in the app.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long recordings take a while to transcribe.
export const maxDuration = 300;

const AUDIO_NAME = /\.(mp3|wav|m4a|mp4|mpeg|mpga|ogg|oga|opus|webm|flac|aac|amr|3gp)$/i;

export async function POST(req: NextRequest) {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    return new Response("Invalid request", { status: 400 });
  }

  if (!file || file.size === 0) {
    return new Response("No file was uploaded.", { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return new Response("The file is larger than 25 MB.", { status: 413 });
  }
  const looksLikeAudio =
    file.type.startsWith("audio/") ||
    file.type.startsWith("video/") ||
    AUDIO_NAME.test(file.name);
  if (!looksLikeAudio) {
    return new Response("That is not a voice recording.", { status: 415 });
  }
  if (!hasOpenAI()) {
    return new Response("OPENAI_API_KEY is not set in .env", { status: 401 });
  }

  const limited = overLimit("file", req);
  if (limited) return limited;

  try {
    const { value, engine } = await route(
      "transcribe",
      fileCandidates(file, file.name || "recording")
    );
    const text = (await toUrduScript(value)).trim();
    if (!text) {
      return new Response("No speech was found in that recording.", {
        status: 422,
      });
    }
    return Response.json({
      text: text.slice(0, MAX_INPUT_LENGTH - 1),
      truncated: text.length > MAX_INPUT_LENGTH - 1,
      engine: engine.label,
    });
  } catch (err) {
    console.error("Could not transcribe the uploaded file:", err);
    return new Response("Could not transcribe that recording.", {
      status: err instanceof EngineError ? err.status ?? 502 : 500,
    });
  }
}
