import React, { useEffect, useState, useRef } from "react";
import { Play } from "./ui/Icons";
import { Button } from "./ui/Button";
import { appStore } from "@/lib/store";
import { clipScript, fetchSpeech, speechRequest } from "@/lib/files";
import { refreshEngineStatus } from "./EngineStatus";
import { getClipTimeline, StreamPlayer } from "@/lib/streamPlayer";
import { alignSpeech, sampleSpeech } from "@/lib/avatar/articulation";
import { avatarBus, type SpeechCues } from "@/lib/avatar/bus";
import { LiveTalk, report, settled } from "@/lib/avatar/liveTalk";
import s from "./ui/Footer.module.css";

const PlayingWaveform = ({
  audioLoaded,
  amplitudeLevels,
}: {
  audioLoaded: boolean;
  amplitudeLevels: number[];
}) => (
  <div className="w-[36px] h-[16px] relative left-[4px]">
    {amplitudeLevels.map((level, idx) => {
      const height = `${Math.min(Math.max(level * 30, 0.2), 1.9) * 100}%`;
      return (
        <div
          key={idx}
          className={`w-[2px] bg-white transition-all duration-150 rounded-[2px] absolute top-1/2 -translate-y-1/2 ${
            audioLoaded ? "opacity-100" : s["animate-wave"]
          }`}
          style={{
            height,
            animationDelay: `${idx * 0.15}s`,
            left: `${idx * 6}px`,
          }}
        />
      );
    })}
  </div>
);

export default function PlayButton() {
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const active = useRef<(() => void) | null>(null);
  const [amplitudeLevels, setAmplitudeLevels] = useState<number[]>(new Array(5).fill(0));

  useEffect(() => () => {
    active.current?.();
    const context = audioContextRef.current;
    audioContextRef.current = null;
    context?.close().catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (active.current) {
      active.current();
      return;
    }

    const requestState = appStore.getState();
    let face: LiveTalk | null = null;
    let player: StreamPlayer | null = null;
    let audio: HTMLAudioElement | null = null;
    let source: AudioNode | null = null;
    let releaseVoice: (() => void) | undefined;
    let objectUrl: string | undefined;
    let interval: number | undefined;
    let tailTimer: number | undefined;
    const abort = new AbortController();

    const finish = () => {
      if (active.current !== finish) return;
      active.current = null;
      abort.abort();
      window.clearInterval(interval);
      window.clearTimeout(tailTimer);
      player?.stop();
      if (audio) {
        audio.onended = audio.onerror = audio.onplay = null;
        audio.pause();
      }
      if (face) {
        report(player ? "play" : "replay", face);
        face.stop();
      }
      source?.disconnect();
      releaseVoice?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      avatarBus.setMood(avatarBus.ear ? "listening" : "idle");
      setIsPlaying(false);
      setAudioLoaded(false);
      setAudioLoading(false);
    };
    active.current = finish;
    setAudioLoading(true);
    avatarBus.setMood("thinking");

    const failed = (err: unknown) => {
      if (active.current !== finish) return;
      finish();
      console.error("Error playing speech:", err);
      refreshEngineStatus();
      alert("Error generating audio");
    };
    const onEnded = () => {
      if (face) {
        const currentFace = face;
        tailTimer = window.setTimeout(() => settled(currentFace).then(finish), currentFace.tail);
      } else finish();
    };
    const onPlay = () => {
      if (active.current !== finish) return;
      avatarBus.setMood("idle");
      refreshEngineStatus();
      setIsPlaying(true);
      setAudioLoaded(true);
      setAudioLoading(false);
      const analyser = avatarBus.voice;
      if (!analyser) return;
      const samples = new Uint8Array(analyser.fftSize);
      interval = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const level = samples.reduce((sum, v) => sum + Math.abs(v - 128), 0) / (128 * samples.length);
        setAmplitudeLevels((prev) => [...prev.slice(1), level]);
      }, 100);
    };
    const cache = (clip: Blob) => {
      const state = appStore.getState();
      if (active.current === finish && state.input === requestState.input &&
          state.voice === requestState.voice && state.prompt === requestState.prompt &&
          state.urduMode === requestState.urduMode) {
        appStore.setState({ latestAudio: clip });
      }
    };

    try {
      let ctx = audioContextRef.current;
      try {
        ctx ??= new AudioContext();
        audioContextRef.current = ctx;
        await ctx.resume();
      } catch {
        ctx = null;
      }
      if (active.current !== finish) return;

      let clip = requestState.latestAudio;
      let init: RequestInit | undefined;
      if (!clip) {
        init = (await speechRequest()).init;
        if (active.current !== finish) return;
        if (!ctx) {
          clip = await fetchSpeech({ ...init, signal: abort.signal });
          if (active.current !== finish) return;
          cache(clip);
        }
      }

      let cues: SpeechCues | undefined;
      if (clip) {
        objectUrl = URL.createObjectURL(clip);
        const element = new Audio(objectUrl);
        audio = element;
        audio.onplay = onPlay;
        audio.onended = onEnded;
        audio.onerror = () => failed(element.error);
        if (ctx) {
          const timeline = getClipTimeline(clip);
          if (timeline) {
            cues = {
              sample: () => timeline.visemeAt(element.currentTime),
              phrase: () => timeline.phraseAt(element.currentTime),
            };
          } else {
            const text = clipScript(clip);
            if (text) {
              // Downloads made before the first Play have no sentence frames.
              // Align the saved script against this recording once for playback.
              try {
                const decoded = await ctx.decodeAudioData(await clip.arrayBuffer());
                const times = alignSpeech(text, decoded.getChannelData(0), decoded.sampleRate);
                cues = {
                  sample: () => sampleSpeech(times, element.currentTime),
                  phrase: () => text,
                };
              } catch { /* The audio element may support more codecs than Web Audio. */ }
            }
          }
          if (active.current !== finish) return;
          try { source = ctx.createMediaElementSource(element); } catch {}
        }
      } else if (ctx) {
        const stream = new StreamPlayer(ctx, null);
        player = stream;
        source = stream.analyser;
        cues = { sample: () => stream.viseme, phrase: () => stream.phrase };
        stream.onplay = onPlay;
        stream.onended = onEnded;
        stream.onerror = failed;
        stream.onaudio = cache;
      }

      if (source && ctx) {
        releaseVoice = avatarBus.attachVoice(source, cues);
        const voice = source;
        const output = ctx.destination;
        const direct = () => {
          if (active.current === finish) voice.connect(output);
        };
        const stage = avatarBus.stage;
        if (stage) {
          face = new LiveTalk(stage, { context: ctx, node: voice }, direct);
          try { await face.start(); } catch {
            face.stop();
            face = null;
            direct();
          }
        } else direct();
      }
      if (active.current !== finish) return;
      if (audio) await audio.play();
      else if (player && init) await player.start("/api/generate", init);
    } catch (err) {
      failed(err);
    }
  };

  return (
    <Button
      color="primary"
      onClick={handleSubmit}
      selected={audioLoading || isPlaying}
      className="relative"
    >
      {isPlaying ? (
        <PlayingWaveform
          audioLoaded={audioLoaded}
          amplitudeLevels={amplitudeLevels}
        />
      ) : audioLoading ? (
        <PlayingWaveform
          audioLoaded={false}
          amplitudeLevels={[0.032, 0.032, 0.032, 0.032, 0.032]}
        />
      ) : (
        <Play />
      )}
      <span className="uppercase hidden md:inline pr-3">
        {isPlaying ? "Stop" : audioLoading ? "Busy" : "Play"}
      </span>
    </Button>
  );
}
