import { Candidate, EngineError, route } from "./core";
import {
  OPENAI_BASE,
  REALTIME_URL,
  canUse,
  failed,
  hasOpenAI,
  openaiHeaders,
  openaiKey,
} from "./engines";

// Speech-to-text engines, all on OpenAI:
//   1. Realtime transcription over a WebSocket (live partial text)
//   2. The plain transcription endpoint, one request per spoken turn, used
//      when Realtime cannot be reached or drops in the middle of a session
//
// Docs: https://developers.openai.com/api/docs/guides/realtime-transcription

export const SAMPLE_RATE = 24000;

export const LANGUAGES = (process.env.OPENAI_TRANSCRIBE_LANGUAGES || "ur")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);

// Urdu and Hindi sound alike, and without a hint the models often write
// Urdu speech in Devanagari. This tells them which script to write.
const SCRIPT_HINT = LANGUAGES.includes("ur")
  ? "یہ پاکستانی اردو کی گفتگو ہے، جس میں انگریزی الفاظ بھی آتے ہیں۔ ہر لفظ اردو رسم الخط میں لکھیں، دیوناگری یا رومن میں نہیں۔ مثال: ارے یار، تم کہاں تھے؟ میں آفس کے باہر ویٹ کر رہی تھی۔"
  : "";

type RealtimeSpec = {
  model: string;
  // No server-side voice detection: the caller must commit each turn.
  manualCommit: boolean;
};

// Best first. gpt-transcribe is the high-accuracy model (and the cheapest):
// it transcribes each turn once it is committed, so text appears a moment
// after a sentence ends. gpt-live-transcribe shows words while they are
// being spoken but is less accurate. The gpt-4o models are the older
// realtime path, with OpenAI's own turn detection.
const REALTIME_MODELS: RealtimeSpec[] = [
  { model: "gpt-transcribe", manualCommit: true },
  { model: "gpt-live-transcribe", manualCommit: true },
  { model: "gpt-4o-transcribe", manualCommit: false },
  { model: "gpt-4o-mini-transcribe", manualCommit: false },
];

const CLIP_MODELS = [
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
];

const CONNECT_TIMEOUT_MS = 8000;
const ACK_TIMEOUT_MS = 2500;

export type Handlers = {
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void;
  // One turn could not be transcribed; the connection is still usable.
  onTurnFailed: (message: string) => void;
  // The connection is gone; the session must move to another engine.
  onFatal: (err: Error) => void;
};

export type RealtimeEngine = {
  id: string;
  label: string;
  manualCommit: boolean;
  append: (pcm: Buffer) => void;
  commit: () => void;
  // Throws away audio appended since the last commit.
  clear: () => void;
  close: () => void;
};

function sessionUpdate({ model, manualCommit }: RealtimeSpec) {
  const transcription: Record<string, unknown> = { model };
  if (SCRIPT_HINT) transcription.prompt = SCRIPT_HINT;
  if (LANGUAGES.length) {
    // gpt-live-transcribe takes `languages`; the older models `language`.
    if (manualCommit) transcription.languages = LANGUAGES;
    else transcription.language = LANGUAGES[0];
  }
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription,
          turn_detection: manualCommit ? null : { type: "server_vad" },
        },
      },
    },
  };
}

// Opens a Realtime transcription session. Resolves once OpenAI has accepted
// the session config; rejects if the connection or the config is refused,
// which sends the router on to the next engine.
function connect(
  spec: RealtimeSpec,
  handlers: Handlers
): Promise<RealtimeEngine> {
  return new Promise((resolve, reject) => {
    // Node's built-in WebSocket accepts headers in its options object.
    const ws = new (WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> }
    ) => WebSocket)(REALTIME_URL, {
      headers: { Authorization: `Bearer ${openaiKey()}` },
    });

    let ready = false;
    let over = false;
    let timer = setTimeout(
      () => fail(new EngineError("Realtime connection timed out")),
      CONNECT_TIMEOUT_MS
    );

    const send = (event: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };

    const engine: RealtimeEngine = {
      id: `transcribe:${spec.model}`,
      label: spec.model,
      manualCommit: spec.manualCommit,
      append: (pcm) =>
        send({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        }),
      commit: () => send({ type: "input_audio_buffer.commit" }),
      clear: () => send({ type: "input_audio_buffer.clear" }),
      close: () => {
        over = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
      },
    };

    function fail(err: Error) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (ready) handlers.onFatal(err);
      else reject(err);
    }

    const becomeReady = () => {
      if (ready || over) return;
      ready = true;
      clearTimeout(timer);
      resolve(engine);
    };

    ws.addEventListener("open", () => {
      send(sessionUpdate(spec));
      clearTimeout(timer);
      // No refusal within this window counts as accepted.
      timer = setTimeout(becomeReady, ACK_TIMEOUT_MS);
    });

    ws.addEventListener("message", (message) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const type = String(event.type ?? "");
      const error = event.error as { message?: string } | undefined;

      if (type.endsWith("session.updated")) {
        becomeReady();
      } else if (type === "conversation.item.input_audio_transcription.delta") {
        handlers.onDelta(String(event.item_id), String(event.delta ?? ""));
      } else if (
        type === "conversation.item.input_audio_transcription.completed"
      ) {
        handlers.onFinal(String(event.item_id), String(event.transcript ?? ""));
      } else if (
        type === "conversation.item.input_audio_transcription.failed"
      ) {
        handlers.onTurnFailed(error?.message || "transcription failed");
      } else if (type === "error") {
        const text = error?.message || "Realtime API error";
        // Refused before it started: the model or config is not usable, and
        // that will not change in the next few minutes.
        if (!ready) fail(new EngineError(`${spec.model}: ${text}`, 404));
        else handlers.onTurnFailed(text);
      }
    });

    ws.addEventListener("error", () =>
      fail(new EngineError(`${spec.model}: Realtime connection failed`))
    );
    ws.addEventListener("close", () =>
      fail(new EngineError(`${spec.model}: Realtime connection closed`))
    );
  });
}

export function realtimeCandidates(
  handlers: Handlers
): Candidate<RealtimeEngine>[] {
  return REALTIME_MODELS.map((spec) => ({
    id: `transcribe:${spec.model}`,
    label: spec.model,
    available: () => canUse(spec.model),
    run: () => connect(spec, handlers),
  }));
}

// ------------------------------------------------ one request per turn

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function clipCandidates(pcm: Buffer): Candidate<string>[] {
  return CLIP_MODELS.map((model) => ({
    id: `transcribe:clip:${model}`,
    label: `${model} (per turn)`,
    available: () => canUse(model),
    run: async () => {
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "json");
      if (LANGUAGES.length) form.append("language", LANGUAGES[0]);
      if (SCRIPT_HINT) form.append("prompt", SCRIPT_HINT);
      form.append(
        "file",
        new Blob([new Uint8Array(wav(pcm))], { type: "audio/wav" }),
        "turn.wav"
      );
      const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: openaiHeaders(),
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) await failed(res, model);
      return String((await res.json()).text ?? "").trim();
    },
  }));
}

// Transcribes an uploaded recording (any common audio format).
export function fileCandidates(file: Blob, name: string): Candidate<string>[] {
  return CLIP_MODELS.map((model) => ({
    id: `transcribe:clip:${model}`,
    label: `${model} (file)`,
    available: () => canUse(model),
    run: async () => {
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "json");
      if (LANGUAGES.length) form.append("language", LANGUAGES[0]);
      form.append("file", file, name);
      const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: openaiHeaders(),
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) await failed(res, model);
      return String((await res.json()).text ?? "").trim();
    },
  }));
}

// Transcribes one finished turn with whichever clip model is working.
export async function transcribeClip(pcm: Buffer): Promise<string> {
  return (await route("transcribe", clipCandidates(pcm))).value;
}

// The engines to try when a session starts: every Realtime model, then the
// per-turn path, which needs no connection and so always "connects".
export function sessionCandidates(
  handlers: Handlers
): Candidate<RealtimeEngine | null>[] {
  return [
    ...realtimeCandidates(handlers),
    {
      id: "transcribe:per-turn",
      label: "per-turn transcription",
      available: hasOpenAI,
      run: async () => null,
    },
  ];
}
