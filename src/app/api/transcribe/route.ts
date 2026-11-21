import { NextRequest } from "next/server";
import { reportFailure, route } from "@/lib/router/core";
import { hasOpenAI } from "@/lib/router/engines";
import { hasDevanagari, toUrduScript } from "@/lib/router/urdu";
import { overLimit } from "@/lib/usage";
import {
  RealtimeEngine,
  SAMPLE_RATE,
  sessionCandidates,
  transcribeClip,
} from "@/lib/router/transcribe";

// Live speech-to-text for the MIC button.
//
//   GET  /api/transcribe?id=…   starts a session and streams transcript
//                               events back as server-sent events
//   POST /api/transcribe?id=…   receives mono PCM16 24 kHz microphone audio
//
// The router chooses the engine: an OpenAI Realtime transcription model when
// one connects, otherwise one transcription request per spoken turn. The
// audio of every turn is kept here until its transcript has arrived, so if
// the live connection fails mid-sentence the turn is transcribed the other
// way instead of being lost.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPEECH_RMS = 0.012; // loudness above which a chunk counts as speech
const END_OF_TURN_MS = 700; // silence after speech that ends a turn
const MAX_TURN_MS = 25_000; // long monologues are cut into turns
const MIN_TURN_MS = 250; // shorter clips are not worth a request
const MIN_SPEECH_MS = 200; // less loud audio than this is a click, not speech
const PREROLL_CHUNKS = 3; // quiet audio kept from just before speech starts
const STOP_GRACE_MS = 9000; // wait this long for the last transcripts
const MAX_SESSION_MS = 10 * 60_000;
const MAX_CHUNK_BYTES = 480_000; // ten seconds of audio per request
const FRAME_BYTES = (SAMPLE_RATE / 10) * 2; // 100 ms

type Session = {
  // undefined while connecting, null = per-turn transcription
  engine: RealtimeEngine | null | undefined;
  connected: Promise<void>;
  emit: (event: string, data: unknown) => void;
  preroll: Buffer[];
  turn: Buffer[]; // audio of the turn being spoken
  speechMs: number;
  silenceMs: number;
  turnMs: number;
  awaiting: Buffer[]; // turns sent to Realtime with no transcript yet
  clipJobs: number; // per-turn requests and script conversions in flight
  hidden: Set<string>; // turns whose partial text is not shown
  heardSinceFinal: boolean;
  failures: number;
  clipSeq: number;
  stopping: boolean;
  close: () => void;
};

const globalStore = globalThis as unknown as {
  __transcribeSessions?: Map<string, Session>;
};
const sessions = (globalStore.__transcribeSessions ??= new Map());

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

const durationMs = (pcm: Buffer) => (pcm.length / 2 / SAMPLE_RATE) * 1000;

function finishIfDone(session: Session) {
  const waitingOnRealtime =
    session.engine &&
    (session.awaiting.length > 0 ||
      (!session.engine.manualCommit && session.heardSinceFinal));
  if (session.stopping && !waitingOnRealtime && session.clipJobs === 0) {
    session.close();
  }
}

// Sends a finished transcript to the page, in Urdu script.
function emitFinal(session: Session, itemId: string, transcript: string) {
  if (!hasDevanagari(transcript)) {
    session.emit("final", { item_id: itemId, transcript });
    return;
  }
  session.clipJobs += 1;
  toUrduScript(transcript)
    .then((urdu) => session.emit("final", { item_id: itemId, transcript: urdu }))
    .finally(() => {
      session.clipJobs -= 1;
      finishIfDone(session);
    });
}

// Partial text is shown as it is heard, unless the engine is writing it in
// Devanagari: then the turn shows a placeholder until its final text is in.
function emitDelta(session: Session, itemId: string, delta: string) {
  if (session.hidden.has(itemId)) return;
  if (hasDevanagari(delta)) {
    session.hidden.add(itemId);
    session.emit("replace", { item_id: itemId, text: "…" });
    return;
  }
  session.emit("delta", { item_id: itemId, delta });
}

// Transcribes one turn with a plain request. A placeholder event reserves
// the turn's place in the transcript, since answers can arrive out of order.
function transcribeTurn(session: Session, pcm: Buffer) {
  if (durationMs(pcm) < MIN_TURN_MS) return;
  const itemId = `turn_${session.clipSeq++}`;
  session.emit("delta", { item_id: itemId, delta: "" });
  session.clipJobs += 1;
  transcribeClip(pcm)
    .then((text) => emitFinal(session, itemId, text))
    .catch((err) => {
      console.error("Per-turn transcription failed:", err);
      session.emit("error", {
        message: "Could not transcribe that sentence. Please say it again.",
      });
    })
    .finally(() => {
      session.clipJobs -= 1;
      finishIfDone(session);
    });
}

// Leaves the live connection for per-turn transcription and replays every
// turn that was still waiting for its transcript.
function switchToPerTurn(session: Session) {
  if (!session.engine) return;
  session.engine.close();
  session.engine = null;
  session.emit("engine", { label: "per-turn transcription" });
  const waiting = session.awaiting;
  session.awaiting = [];
  waiting.forEach((pcm) => transcribeTurn(session, pcm));
}

function endTurn(session: Session) {
  const pcm = Buffer.concat(session.turn);
  const spokenMs = session.speechMs;
  session.turn = [];
  session.speechMs = 0;
  session.silenceMs = 0;
  session.turnMs = 0;

  if (spokenMs < MIN_SPEECH_MS) {
    // A cough or a door, not a sentence: drop it instead of transcribing it.
    if (session.engine?.manualCommit) session.engine.clear();
    return;
  }

  if (!session.engine) {
    transcribeTurn(session, pcm);
  } else {
    if (session.engine.manualCommit) session.engine.commit();
    session.awaiting.push(pcm);
  }
}

function handleAudio(session: Session, pcm: Buffer) {
  const speaking = rms(pcm) >= SPEECH_RMS;
  const inTurn = session.speechMs > 0;
  const chunkMs = durationMs(pcm);

  // Engines with their own turn detection need the whole stream; the
  // manual-commit engine only gets the audio of each turn.
  if (session.engine && !session.engine.manualCommit) {
    session.engine.append(pcm);
  }

  if (!inTurn && !speaking) {
    session.preroll.push(pcm);
    if (session.preroll.length > PREROLL_CHUNKS) session.preroll.shift();
    return;
  }

  if (!inTurn) {
    session.turn = session.preroll;
    session.preroll = [];
    if (session.engine?.manualCommit) {
      session.turn.forEach((chunk) => session.engine?.append(chunk));
    }
  }

  session.turn.push(pcm);
  if (session.engine?.manualCommit) session.engine.append(pcm);
  session.heardSinceFinal = true;
  session.turnMs += chunkMs;
  if (speaking) {
    session.speechMs += chunkMs;
    session.silenceMs = 0;
  } else {
    session.silenceMs += chunkMs;
  }

  if (
    session.silenceMs >= END_OF_TURN_MS ||
    session.turnMs >= MAX_TURN_MS
  ) {
    endTurn(session);
  }
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!VALID_ID.test(id) || sessions.has(id)) {
    return new Response("Invalid session id", { status: 400 });
  }
  if (!hasOpenAI()) {
    return new Response("OPENAI_API_KEY is not set in .env", { status: 401 });
  }

  const limited = overLimit("mic", req);
  if (limited) return limited;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setTimeout>[] = [];

      const emit = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const close = () => {
        if (closed) return;
        emit("closed", {});
        closed = true;
        timers.forEach(clearTimeout);
        sessions.delete(id);
        session.engine?.close();
        try {
          controller.close();
        } catch {}
      };

      const session: Session = {
        engine: undefined,
        connected: Promise.resolve(),
        emit,
        preroll: [],
        turn: [],
        speechMs: 0,
        silenceMs: 0,
        turnMs: 0,
        awaiting: [],
        clipJobs: 0,
        hidden: new Set(),
        heardSinceFinal: false,
        failures: 0,
        clipSeq: 0,
        stopping: false,
        close,
      };
      sessions.set(id, session);

      const handlers = {
        onDelta: (itemId: string, delta: string) =>
          emitDelta(session, itemId, delta),
        onFinal: (itemId: string, transcript: string) => {
          emitFinal(session, itemId, transcript);
          session.failures = 0;
          session.heardSinceFinal = false;
          // With OpenAI's own turn detection the turns do not line up one
          // to one with ours, so a transcript settles everything before it.
          if (session.engine?.manualCommit) session.awaiting.shift();
          else session.awaiting = [];
          finishIfDone(session);
        },
        onTurnFailed: (message: string) => {
          console.warn("[transcribe] turn failed:", message);
          session.failures += 1;
          const pcm = session.awaiting.shift();
          if (pcm) transcribeTurn(session, pcm);
          // Twice in a row means the live engine is not coping.
          if (session.failures >= 2 && session.engine) {
            reportFailure(session.engine.id, new Error(message));
            switchToPerTurn(session);
          }
          finishIfDone(session);
        },
        onFatal: (err: Error) => {
          if (closed || !session.engine) return;
          reportFailure(session.engine.id, err);
          switchToPerTurn(session);
          finishIfDone(session);
        },
      };

      session.connected = route("transcribe", sessionCandidates(handlers))
        .then(({ value, engine }) => {
          if (closed) {
            value?.close();
            return;
          }
          session.engine = value;
          emit("ready", { engine: engine.label });
        })
        .catch((err) => {
          emit("error", {
            message:
              "No OpenAI transcription engine could be started: " +
              (err instanceof Error ? err.message : String(err)),
          });
          close();
        });

      req.signal.addEventListener("abort", close);
      timers.push(setTimeout(close, MAX_SESSION_MS));
    },
    cancel() {
      sessions.get(id)?.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id") || "";
  const session = sessions.get(id);
  if (!session) {
    return new Response("Unknown session", { status: 404 });
  }

  const stop = params.get("stop") === "1";
  const pcm = stop ? null : Buffer.from(await req.arrayBuffer());
  if (pcm && (!pcm.length || pcm.length % 2 || pcm.length > MAX_CHUNK_BYTES)) {
    return new Response("Invalid audio chunk", { status: 400 });
  }

  // Audio that arrives while the engine is still connecting waits for it.
  await session.connected;
  if (sessions.get(id) !== session || session.stopping) {
    return new Response(null, { status: 204 });
  }

  if (pcm) {
    // A request can carry several chunks at once. Turn detection works on
    // 100 ms steps, so feed it in steps of that size.
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      handleAudio(session, pcm.subarray(offset, offset + FRAME_BYTES));
    }
    return new Response(null, { status: 204 });
  }

  // The microphone was switched off: close the turn being spoken and keep
  // the event stream open until the last transcripts have arrived.
  session.stopping = true;
  if (session.speechMs > 0) {
    endTurn(session);
  }
  if (session.engine && !session.engine.manualCommit) {
    // OpenAI's turn detection needs to hear silence to finish the turn.
    session.engine.append(Buffer.alloc(SAMPLE_RATE * 2));
  }
  finishIfDone(session);
  setTimeout(session.close, STOP_GRACE_MS);
  return new Response(null, { status: 204 });
}
