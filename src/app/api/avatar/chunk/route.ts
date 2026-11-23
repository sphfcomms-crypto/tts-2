import { NextRequest } from "next/server";
import { rendererFor, renderSpeech } from "@/lib/avatarGpu";
import { overLimit } from "@/lib/usage";

// One short chunk of her live-call voice in, video of her saying it out.
//
//   POST /api/avatar/chunk?clip=<name>&start=<frame>&lead=<ms>&tail=<ms>   body: mono WAV
//
// `clip` is which of her body-language clips the chunk is drawn on, and
// `start` the frame of it the chunk begins on. `lead` is how much of the
// start of the WAV is earlier sound, sent only so the mouth begins the
// chunk in the right shape. `tail` is the following sound, also context only. The answer is a short silent MP4, which the
// browser joins to the ones before and keeps in step with her voice (see
// liveTalk.ts).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 200_000; // about four seconds of 24 kHz sound

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const start = Math.max(0, Math.floor(Number(searchParams.get("start")) || 0));
  const lead = Math.max(0, Math.min(1000, Math.floor(Number(searchParams.get("lead")) || 0)));
  const tail = Math.max(0, Math.min(1000, Math.floor(Number(searchParams.get("tail")) || 0)));
  const clip = searchParams.get("clip") || "talk";
  if (!/^[a-z0-9_]{1,40}$/.test(clip)) {
    return new Response("Bad clip", { status: 400 });
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length < 44 || body.length > MAX_BYTES) {
    return new Response("Bad chunk", { status: 400 });
  }
  let renderer = await rendererFor(clip, searchParams.get("renderer") === "cpu");
  if (!renderer) {
    return new Response("The avatar video is unavailable.", { status: 503 });
  }
  const limited = overLimit("video", req);
  if (limited) return limited;

  try {
    const options = { clip, lead, tail, sound: false, signal: req.signal };
    let rendered;
    try {
      rendered = await renderSpeech(renderer, body, start, options);
    } catch (error) {
      if (req.signal.aborted || renderer.kind === "cpu") throw error;
      const local = await rendererFor(clip, true);
      if (!local) throw error;
      renderer = local;
      rendered = await renderSpeech(local, body, start, options);
    }
    const { video, next, acoustic } = rendered;
    return new Response(new Uint8Array(video), {
      headers: {
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store, no-transform",
        "X-Next-Start": String(next),
        "X-Avatar-Renderer": renderer.kind,
        ...(acoustic ? { "X-Avatar-Acoustic": acoustic } : {}),
      },
    });
  } catch (err) {
    if (!req.signal.aborted) console.error("Avatar chunk failed:", err);
    return new Response("Could not make the video.", { status: 502 });
  }
}
