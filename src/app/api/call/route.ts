import { NextRequest } from "next/server";
import { CALL_GREETING, callInstructions } from "@/lib/callPersona";
import { VOICES } from "@/lib/library";
import { MAX_PROMPT_LENGTH } from "@/lib/limits";
import { EngineError, route } from "@/lib/router/core";
import { callCandidates, hangUp } from "@/lib/router/call";
import { hasOpenAI } from "@/lib/router/engines";
import { overLimit } from "@/lib/usage";

// Starts a live two-way voice call.
//
//   POST   /api/call           { sdp, voice, prompt, greet } -> { sdp, sessionId, maxSeconds }
//   DELETE /api/call?id=…      ends a call early (the browser also ends it
//                              itself; this is the belt to that braces)
//
// A call is billed by the minute for as long as it is connected, so every
// call gets a hard time limit, enforced here and not only in the browser.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SDP_LENGTH = 20_000;
const maxMinutes = () => {
  const value = Number(process.env.CALL_MAX_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : 10;
};

const store = globalThis as unknown as {
  __calls?: Map<string, ReturnType<typeof setTimeout>>;
};
const calls = (store.__calls ??= new Map());

function endCall(sessionId: string) {
  const timer = calls.get(sessionId);
  if (timer) clearTimeout(timer);
  calls.delete(sessionId);
  hangUp(sessionId);
}

export async function POST(req: NextRequest) {
  let sdp = "";
  let voice = "";
  let prompt = "";
  let greet = true;
  try {
    const body = await req.json();
    sdp = typeof body.sdp === "string" ? body.sdp : "";
    voice = typeof body.voice === "string" ? body.voice : "";
    prompt = typeof body.prompt === "string" ? body.prompt : "";
    greet = body.greet !== false;
  } catch {
    return new Response("Invalid request", { status: 400 });
  }

  if (!sdp.startsWith("v=0") || sdp.length > MAX_SDP_LENGTH) {
    return new Response("Invalid connection offer", { status: 400 });
  }
  // Only the young female voices are accepted.
  if (!VOICES.includes(voice)) {
    return new Response("Invalid voice", { status: 400 });
  }
  if (!hasOpenAI()) {
    return new Response("OPENAI_API_KEY is not set in .env", { status: 401 });
  }

  const limited = overLimit("call", req);
  if (limited) return limited;

  try {
    const { value, engine } = await route(
      "call",
      callCandidates({
        sdp,
        voice,
        instructions: callInstructions(prompt.slice(0, MAX_PROMPT_LENGTH)),
        greeting: greet ? CALL_GREETING : "",
      })
    );

    const maxSeconds = Math.round(maxMinutes() * 60);
    if (value.sessionId) {
      // A few seconds of grace so the browser's own timer ends it first.
      calls.set(
        value.sessionId,
        setTimeout(() => endCall(value.sessionId), (maxSeconds + 5) * 1000)
      );
    }

    return Response.json({
      sdp: value.sdp,
      sessionId: value.sessionId,
      engine: engine.label,
      maxSeconds,
    });
  } catch (err) {
    console.error("Could not start the call:", err);
    return new Response("Could not start the call.", {
      status: err instanceof EngineError ? err.status ?? 502 : 500,
    });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  // Only calls this server started can be ended through it.
  if (calls.has(id)) endCall(id);
  return new Response(null, { status: 204 });
}
