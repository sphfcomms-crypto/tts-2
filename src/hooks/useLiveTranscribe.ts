import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "starting" | "listening" | "finishing";

type Options = {
  // Called with everything heard so far in this recording, every time a
  // partial or final piece of transcript arrives.
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
};

const STOP_WAIT_MS = 7000;

// Records the microphone and streams it through /api/transcribe, which
// relays it to the OpenAI Realtime transcription API.
export function useLiveTranscribe({ onTranscript, onError }: Options) {
  const [status, setStatus] = useState<Status>("idle");

  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };

  const sessionId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  const releaseMic = useCallback(() => {
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
    audioContext.current?.close().catch(() => {});
    audioContext.current = null;
  }, []);

  const teardown = useCallback(() => {
    releaseMic();
    abort.current?.abort();
    abort.current = null;
    sessionId.current = null;
    setStatus("idle");
  }, [releaseMic]);

  // Reads the server-sent events and rebuilds the transcript. Turns are
  // kept in the order they were first heard; a final transcript replaces
  // the partial text of its turn.
  const readEvents = useCallback(
    async (body: ReadableStream<Uint8Array>) => {
      const order: string[] = [];
      const turns = new Map<string, string>();
      const publish = () => {
        callbacks.current.onTranscript(
          order
            .map((id) => (turns.get(id) ?? "").trim())
            .filter(Boolean)
            .join(" ")
        );
      };
      const touch = (id: string) => {
        if (!turns.has(id)) {
          order.push(id);
          turns.set(id, "");
        }
      };

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const event = raw.match(/^event: (.*)$/m)?.[1];
          const dataLine = raw.match(/^data: (.*)$/m)?.[1];
          if (!event || !dataLine) continue;
          const data = JSON.parse(dataLine);

          if (event === "ready") {
            setStatus((current) =>
              current === "starting" ? "listening" : current
            );
          } else if (event === "delta" && data.item_id) {
            touch(data.item_id);
            turns.set(
              data.item_id,
              turns.get(data.item_id) + String(data.delta ?? "")
            );
            publish();
          } else if (event === "replace" && data.item_id) {
            touch(data.item_id);
            turns.set(data.item_id, String(data.text ?? ""));
            publish();
          } else if (event === "final" && data.item_id) {
            touch(data.item_id);
            turns.set(data.item_id, String(data.transcript ?? ""));
            publish();
          } else if (event === "error") {
            callbacks.current.onError(String(data.message));
          } else if (event === "closed") {
            return;
          }
        }
      }
    },
    []
  );

  const start = useCallback(async () => {
    if (sessionId.current) return;
    const id = crypto.randomUUID();
    sessionId.current = id;
    setStatus("starting");

    try {
      // Ask for the microphone first, so no session is opened if it is refused.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStream.current = stream;

      // Open the session and start capturing at the same time. Chunks wait
      // in the queue until the session is open, so words spoken right after
      // the click are not lost.
      const controller = new AbortController();
      abort.current = controller;
      const opening = fetch(`/api/transcribe?id=${id}`, {
        signal: controller.signal,
      });
      // Everything captured so far goes out in one request. On a slow or
      // distant link the chunks pile up while a request is in flight and
      // then leave together, so the upload never falls behind the
      // microphone (one request per chunk did, by seconds).
      const waiting: ArrayBuffer[] = [];
      let open = false;
      let sending = false;
      const pump = () => {
        if (sending || !open || !waiting.length) return;
        sending = true;
        sendQueue.current = (async () => {
          while (waiting.length && sessionId.current === id) {
            // At most 8 s per request; the server accepts 10 s.
            const body = new Blob(waiting.splice(0, 80));
            await fetch(`/api/transcribe?id=${id}`, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body,
            }).catch(() => {});
          }
          sending = false;
        })();
      };

      const context = new AudioContext({ sampleRate: 24000 });
      audioContext.current = context;
      await context.audioWorklet.addModule("/pcm-worklet.js");
      const capture = new AudioWorkletNode(context, "pcm-capture");

      capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (sessionId.current !== id) return;
        waiting.push(data);
        pump();
      };

      context.createMediaStreamSource(stream).connect(capture);

      const res = await opening;
      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || "Could not start transcription.");
      }
      open = true;
      pump();

      readEvents(res.body)
        .catch((err) => {
          if (err?.name !== "AbortError") {
            callbacks.current.onError("The transcription connection dropped.");
          }
        })
        .finally(() => {
          if (sessionId.current === id) teardown();
        });
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "NotFoundError");
      callbacks.current.onError(
        denied
          ? "Microphone not available. Allow microphone access and try again."
          : err instanceof Error
          ? err.message
          : "Could not start transcription."
      );
      teardown();
    }
  }, [readEvents, teardown]);

  const stop = useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    setStatus("finishing");
    releaseMic();

    // Let queued audio go out, then ask the server to commit the last turn.
    // The event stream closes itself once that transcript has arrived.
    await sendQueue.current;
    await fetch(`/api/transcribe?id=${id}&stop=1`, { method: "POST" }).catch(
      () => {}
    );
    setTimeout(() => {
      if (sessionId.current === id) teardown();
    }, STOP_WAIT_MS);
  }, [releaseMic, teardown]);

  useEffect(() => teardown, [teardown]);

  return { status, start, stop };
}
