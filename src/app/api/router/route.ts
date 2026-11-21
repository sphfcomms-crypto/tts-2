import { callCandidates } from "@/lib/router/call";
import { describe } from "@/lib/router/core";
import { hasOpenAI } from "@/lib/router/engines";
import { speechEngines } from "@/lib/router/speech";
import { pageCandidates, textCandidates } from "@/lib/router/text";
import { clipCandidates, realtimeCandidates } from "@/lib/router/transcribe";

// What the router would pick right now for each job, and the state of
// every engine it knows. Read by the status line in the app.

export const dynamic = "force-dynamic";

const noHandlers = {
  onDelta: () => {},
  onFinal: () => {},
  onTurnFailed: () => {},
  onFatal: () => {},
};

export async function GET() {
  const [text, read, speech, transcribe, call] = await Promise.all([
    describe("text", textCandidates("", "", (content) => content)),
    describe("read", pageCandidates("", [], (reading) => reading)),
    describe(
      "speech",
      speechEngines({ input: "", prompt: "", voice: "coral", format: "pcm" })
    ),
    describe("transcribe", [
      ...realtimeCandidates(noHandlers),
      ...clipCandidates(Buffer.alloc(0)),
    ]),
    describe(
      "call",
      callCandidates({ sdp: "", voice: "coral", instructions: "", greeting: "" })
    ),
  ]);

  return Response.json(
    { key: hasOpenAI(), text, read, speech, transcribe, call },
    { headers: { "Cache-Control": "no-store" } }
  );
}
