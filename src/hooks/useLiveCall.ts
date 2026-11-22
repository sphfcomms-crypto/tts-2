import { useCallback, useEffect, useRef, useState } from "react";
import { CallTurns, transcriptSpan } from "@/lib/callTurns";
import { appStore } from "@/lib/store";
import { avatarBus } from "@/lib/avatar/bus";
import { CallCueHistory } from "@/lib/avatar/callAudioHandoff";
import { canShowVideo, LiveTalk, report, type HeldCallAudio } from "@/lib/avatar/liveTalk";

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
  const generation = useRef(0);
  const liveSpeech = useRef<ReturnType<typeof avatarBus.startLiveSpeech> | null>(null);
  // Web Audio taps for the avatar: her voice and the caller's microphone.
  const hearing = useRef<{ context: AudioContext; release: (() => void)[] } | null>(null);
  // Her on video during the call, when the photo-real avatar is on screen.
  const face = useRef<LiveTalk | null>(null);

  const cleanup = useCallback(() => {
    active.current = false;
    generation.current += 1;
    liveSpeech.current?.release();
    liveSpeech.current = null;
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
    if (face.current) report("call", face.current);
    face.current?.stop();
    face.current = null;
    if (hearing.current) {
      hearing.current.release.forEach((release) => release());
      hearing.current.context.close().catch(() => {});
      hearing.current = null;
    }
    appStore.setState({ localCallAvatar: false });
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
      const callGeneration = ++generation.current;
      const isCurrent = () => generation.current === callGeneration;
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
        if (!isCurrent()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mic.current = stream;
        const speech = avatarBus.startLiveSpeech();
        liveSpeech.current = speech;
        const turns = new CallTurns(speech);
        avatarBus.setMood("listening");

        // The avatar listens to the caller and moves her mouth with her
        // own voice. Nothing is played from here: these only measure.
        try {
          const context = new AudioContext();
          hearing.current = {
            context,
            release: [avatarBus.attachEar(context.createMediaStreamSource(stream))],
          };
          void context.resume().catch(() => {});
        } catch {}

        const pc = new RTCPeerConnection();
        peer.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        // Her voice arrives as a normal audio track.
        const audio = new Audio();
        audio.autoplay = true;
        speaker.current = audio;
        let callVoice: AnalyserNode | null = null;
        const cueHistory = new CallCueHistory();
        timers.current.push(window.setInterval(() => {
          if (face.current && callVoice) {
            cueHistory.record(callVoice.context.currentTime, speech.sample(callVoice), speech.phrase());
          }
        }, 25));
        pc.ontrack = (event) => {
          if (!isCurrent()) return;
          const remote = event.streams[0] ?? new MediaStream([event.track]);
          audio.srcObject = remote;

          // LiveTalk plays a delayed copy of the same remote voice, aligned
          // to the generated frames. Restore direct audio if video fails.
          const stage = avatarBus.stage;
          const switchToLocalAvatar = (held?: HeldCallAudio) => {
            if (!isCurrent()) return;
            appStore.setState({ localCallAvatar: true });
            const talk = face.current;
            if (talk) report("call-local", talk);
            const resumeDirect = () => {
              if (!isCurrent() || face.current !== talk) return;
              talk?.stop();
              face.current = null;
              audio.muted = false;
            };
            if (!held) {
              resumeDirect();
              return;
            }
            // During the drain the portrait hears the same gated output as
            // the speaker and looks up the original word at its capture time.
            const played = () => callVoice &&
              cueHistory.at(callVoice.context.currentTime - held.delaySeconds());
            const release = avatarBus.attachVoice(held.output, {
              sample: () => played()?.shape ?? null,
              phrase: () => played()?.phrase ?? "",
            });
            void held.drained.then(() => {
              release();
              resumeDirect();
            });
          };
          if (stage && canShowVideo() && !face.current && !appStore.getState().localCallAvatar) {
            audio.muted = true;
            const talk = new LiveTalk(stage, { stream: remote }, switchToLocalAvatar, greet);
            face.current = talk;
            if (process.env.NODE_ENV !== "production") {
              Object.assign(window, { __liveTalk: talk });
            }
            talk.start().catch(() => {
              if (face.current === talk) switchToLocalAvatar();
            });
          } else {
            switchToLocalAvatar();
          }
          audio.play().catch(() => {});

          const ears = hearing.current;
          if (ears) {
            try {
              ears.release.push(
                avatarBus.attachVoice(
                  ears.context.createMediaStreamSource(remote), speech
                )
              );
              callVoice = avatarBus.voice;
            } catch {}
          }
        };

        // Events (ready, captions, closed) arrive on this channel. It has
        // to exist before the offer is made.
        const events = pc.createDataChannel("oai-events");
        channel.current = events;
        const said = { you: "", her: "" };
        // Use mic activity alongside the session clock. A transcript can
        // arrive after a reply, and a mic spike alone could just be noise.
        const samples = new Float32Array(1024);
        let lastMic = -Infinity;
        let lastInput = -Infinity;
        const listen = () => {
          if (!isCurrent()) return;
          const ear = avatarBus.ear;
          const measuring = ear?.context.state === "running";
          const now = performance.now();
          if (measuring) {
            ear.getFloatTimeDomainData(samples);
            let power = 0;
            for (const sample of samples) power += sample * sample;
            if (power / samples.length > 0.018 ** 2) lastMic = now;
          }
          // Briefly hold a thinking pose in the gap before her answer.
          const quiet = now - (measuring ? lastMic : lastInput) > 400;
          const thinking = turns.waitingForReply && quiet && now - lastInput < 4000;
          avatarBus.setMood(thinking ? "thinking" : "listening");
        };
        timers.current.push(window.setInterval(listen, 80));

        events.onmessage = ({ data }) => {
          if (!isCurrent()) return;
          let event: {
            type?: string; delta?: string; start_ms?: number; end_ms?: number;
            error?: { message?: string };
          };
          try {
            event = JSON.parse(data);
          } catch {
            return;
          }
          if (event.type === "session.started") {
            setStatus("live");
          } else if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
            said.her += event.delta;
            callbacks.current.onCaption("her", said.her);
            if (turns.assistant(event.delta, transcriptSpan(event.start_ms, event.end_ms))) {
              avatarBus.setMood("listening");
            }
          } else if (event.type === "session.input_transcript.delta" && typeof event.delta === "string") {
            said.you += event.delta;
            callbacks.current.onCaption("you", said.you);
            const now = performance.now();
            const span = transcriptSpan(event.start_ms, event.end_ms);
            const measuring = avatarBus.ear?.context.state === "running";
            if (event.delta.trim() && turns.caller(span, measuring ? now - lastMic < 650 : !!span)) {
              lastInput = now;
              if (face.current?.hasSpeech) face.current.interrupt();
              avatarBus.setMood("listening");
            }
          } else if (event.type === "session.closed") {
            sessionId.current = "";
            cleanup();
          } else if (event.type === "error") {
            console.warn("Call error:", event.error);
          }
        };

        pc.onconnectionstatechange = () => {
          if (!isCurrent()) return;
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

        if (!isCurrent()) return;
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
        if (!isCurrent()) {
          // Cancelled while connecting: do not leave the session running.
          fetch(`/api/call?id=${encodeURIComponent(answer.sessionId)}`, {
            method: "DELETE",
          }).catch(() => {});
          return;
        }
        sessionId.current = answer.sessionId;
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        if (!isCurrent()) return;

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
        if (!isCurrent()) return;
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
