import { Candidate, EngineError } from "./core";
import {
  OPENAI_BASE,
  canUse,
  failed,
  openaiHeaders,
  openaiKey,
} from "./engines";

// The live two-way call. The browser talks to OpenAI directly over WebRTC;
// this server only adds the API key and the session settings to the
// browser's connection offer, so the key never leaves the server.
//
// Docs: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live

// Full-duplex voice models, best first.
const CALL_MODELS = ["gpt-live-1.1", "gpt-live-1"];

export type CallRequest = {
  sdp: string; // the browser's WebRTC offer
  voice: string;
  instructions: string;
  greeting: string;
};

export type CallAnswer = { sdp: string; sessionId: string };

export function callCandidates(req: CallRequest): Candidate<CallAnswer>[] {
  return CALL_MODELS.map((model) => ({
    id: `call:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () => {
      const res = await fetch(`${OPENAI_BASE}/live/sessions`, {
        method: "POST",
        headers: { ...openaiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            model,
            instructions: req.instructions,
            audio: { output: { voice: req.voice } },
            // A developer message at the start makes her speak first.
            // With no greeting she waits for the caller.
            ...(req.greeting && {
              input: [
                {
                  type: "message",
                  role: "developer",
                  content: [{ type: "input_text", text: req.greeting }],
                },
              ],
            }),
          },
          transport: { type: "webrtc", sdp: req.sdp },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) await failed(res, model);

      const data = await res.json();
      const sdp = data?.transport?.sdp;
      if (typeof sdp !== "string" || !sdp) {
        throw new EngineError(`${model} returned no connection answer`);
      }
      return { sdp, sessionId: String(data?.session?.id ?? "") };
    },
  }));
}

// Ends a call from the server by attaching to the session and asking it to
// close. Used to enforce the maximum call length; a call that has already
// ended simply refuses the connection.
export function hangUp(sessionId: string) {
  if (!sessionId) return;
  const url = `${OPENAI_BASE.replace(/^http/, "ws")}/live/sessions/${encodeURIComponent(
    sessionId
  )}/attach`;
  try {
    // Node's built-in WebSocket accepts headers in its options object.
    const ws = new (WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> }
    ) => WebSocket)(url, {
      headers: { Authorization: `Bearer ${openaiKey()}` },
    });
    const done = () => {
      try {
        ws.close();
      } catch {}
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "session.close" }));
      setTimeout(done, 3000);
    });
    ws.addEventListener("error", done);
  } catch (err) {
    console.warn("[call] could not end the session:", err);
  }
}
