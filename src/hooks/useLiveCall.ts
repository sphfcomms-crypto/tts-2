import { useCallback, useEffect, useRef, useState } from "react";
import { avatarBus } from "@/lib/avatar/bus";
import { LiveTalk } from "@/lib/avatar/liveTalk";
import { canPlayTalk } from "@/lib/avatar/talkPlayer";

export type CallStatus = "idle" | "connecting" | "live";

type Options = {
  // Running text of what each side has said in this call.
  onCaption: (who: "you" | "her", text: string) => void;
  onError: (message: string) => void;
};

const ICE_WAIT_MS = 2500;

// A live two-way voice call. The browser connects to the voice model
// directly over WebRTC (microphone out, her voice back); /api/call only
// brokers the connection so the API key stays on the server.
export function useLiveCall({ onCaption, onError }: Options) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [seconds, setSeconds] = useState(0);

  const callbacks = useRef({ onCaption, onError });
  callbacks.current = { onCaption, onError };

  const peer = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const speaker = useRef<HTMLAudioElement | null>(null);
  const sessionId = useRef("");
  const timers = useRef<number[]>([]);
  const active = useRef(false);
  // Web Audio taps for the avatar: her voice and the caller's microphone.
  const hearing = useRef<{ context: AudioContext; release: (() => void)[] } | null>(null);
  // Her on video during the call, when the photo-real avatar is on screen.
  const face = useRef<LiveTalk | null>(null);

  const cleanup = useCallback(() => {
    active.current = false;
    timers.current.forEach((t) => window.clearInterval(t));
    timers.current = [];
    mic.current?.getTracks().forEach((track) => track.stop());
    mic.current = null;
    try {
      channel.current?.close();
    } catch {}
    channel.current = null;
    try {
      peer.current?.close();
    } catch {}
    peer.current = null;
    if (speaker.current) {
      speaker.current.pause();
      speaker.current.srcObject = null;
      speaker.current = null;
    }
    face.current?.stop();
    face.current = null;
    if (hearing.current) {
      hearing.current.release.forEach((release) => release());
      hearing.current.context.close().catch(() => {});
      hearing.current = null;
    }
    avatarBus.setMood("idle");
    setStatus("idle");
  }, []);

  const stop = useCallback(() => {
    if (!active.current) return;
    // Ask the model to end the session, tell the server too, then let go.
    try {
      if (channel.current?.readyState === "open") {
        channel.current.send(JSON.stringify({ type: "session.close" }));
      }
    } catch {}
    if (sessionId.current) {
      fetch(`/api/call?id=${encodeURIComponent(sessionId.current)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
      sessionId.current = "";
    }
    cleanup();
  }, [cleanup]);

  const start = useCallback(
    async (voice: string, prompt: string, greet: boolean) => {
      if (active.current) return;
      active.current = true;
      setStatus("connecting");
      setSeconds(0);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (!active.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mic.current = stream;

        // The avatar listens to the caller and moves her mouth with her
        // own voice. Nothing is played from here: these only measure.
        try {
          const context = new AudioContext();
          hearing.current = {
            context,
            release: [avatarBus.attachEar(context.createMediaStreamSource(stream))],
          };
          avatarBus.setMood("listening");
        } catch {}

        const pc = new RTCPeerConnection();
        peer.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        // Her voice arrives as a normal audio track.
        const audio = new Audio();
        audio.autoplay = true;
        speaker.current = audio;
        pc.ontrack = (event) => {
          audio.srcObject = event.streams[0];
          audio.play().catch(() => {});

          // On video, her voice is heard from the video itself (it is in
          // time with her lips there), so the direct sound is muted. If the
          // video cannot be made, the direct sound comes back.
          const stage = avatarBus.stage;
          if (stage && canPlayTalk() && !face.current) {
            audio.muted = true;
            const talk = new LiveTalk(stage, event.streams[0], () => {
              audio.muted = false;
            });
            face.current = talk;
            if (process.env.NODE_ENV !== "production") {
              Object.assign(window, { __liveTalk: talk });
            }
            talk.start().catch(() => {
              audio.muted = false;
            });
          }

          const ears = hearing.current;
          if (ears) {
            try {
              ears.release.push(
                avatarBus.attachVoice(
                  ears.context.createMediaStreamSource(event.streams[0])
                )
              );
            } catch {}
          }
        };

        // Events (ready, captions, closed) arrive on this channel. It has
        // to exist before the offer is made.
        const events = pc.createDataChannel("oai-events");
        channel.current = events;
        const said = { you: "", her: "" };
        events.onmessage = ({ data }) => {
          let event: { type?: string; delta?: string; error?: { message?: string } };
          try {
            event = JSON.parse(data);
          } catch {
            return;
          }
          if (event.type === "session.started") {
            setStatus("live");
          } else if (event.type === "session.output_transcript.delta") {
            said.her += event.delta ?? "";
            callbacks.current.onCaption("her", said.her);
          } else if (event.type === "session.input_transcript.delta") {
            said.you += event.delta ?? "";
            callbacks.current.onCaption("you", said.you);
          } else if (event.type === "session.closed") {
            sessionId.current = "";
            cleanup();
          } else if (event.type === "error") {
            console.warn("Call error:", event.error);
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "connected") {
            setStatus("live");
          } else if (
            pc.connectionState === "failed" ||
            pc.connectionState === "closed"
          ) {
            if (active.current) {
              if (pc.connectionState === "failed") {
                callbacks.current.onError("The call connection was lost.");
              }
              stop();
            }
          }
        };

        await pc.setLocalDescription(await pc.createOffer());
        // Wait for the network candidates, so one request carries them all.
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          const timer = window.setTimeout(resolve, ICE_WAIT_MS);
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") {
              window.clearTimeout(timer);
              resolve();
            }
          });
        });

        const res = await fetch("/api/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sdp: pc.localDescription?.sdp,
            voice,
            prompt,
            greet,
          }),
        });
        if (!res.ok) {
          throw new Error((await res.text()) || "Could not start the call.");
        }
        const answer = await res.json();
        if (!active.current) {
          // Cancelled while connecting: do not leave the session running.
          fetch(`/api/call?id=${encodeURIComponent(answer.sessionId)}`, {
            method: "DELETE",
          }).catch(() => {});
          return;
        }
        sessionId.current = answer.sessionId;
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

        // Clock, and the hard stop at the maximum call length.
        const began = Date.now();
        const limit = Number(answer.maxSeconds) || 600;
        timers.current.push(
          window.setInterval(() => {
            const elapsed = Math.floor((Date.now() - began) / 1000);
            setSeconds(elapsed);
            if (elapsed >= limit) stop();
          }, 500)
        );
      } catch (err) {
        const denied =
          err instanceof DOMException &&
          (err.name === "NotAllowedError" || err.name === "NotFoundError");
        callbacks.current.onError(
          denied
            ? "Microphone not available. Allow microphone access and try again."
            : err instanceof Error
            ? err.message
            : "Could not start the call."
        );
        stop();
        cleanup();
      }
    },
    [cleanup, stop]
  );

  // Leaving the page ends the call.
  useEffect(() => {
    const leave = () => stop();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      stop();
    };
  }, [stop]);

  return { status, seconds, start, stop };
}
