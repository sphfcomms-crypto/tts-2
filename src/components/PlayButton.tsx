import React, { useState, useRef } from "react";
import { Play } from "./ui/Icons";
import { Button } from "./ui/Button";
import { appStore } from "@/lib/store";
import { IS_BLINK, fetchSpeech, speechRequest } from "@/lib/files";
import { refreshEngineStatus } from "./EngineStatus";
import { StreamPlayer } from "@/lib/streamPlayer";
import { avatarBus } from "@/lib/avatar/bus";
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

  const audioRef = useRef<{ pause: () => void } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Lets go of the avatar's tap on the clip that is playing.
  const releaseVoice = useRef<(() => void) | null>(null);
  const quietAvatar = () => {
    releaseVoice.current?.();
    releaseVoice.current = null;
    avatarBus.setMood("idle");
  };
  const [amplitudeLevels, setAmplitudeLevels] = useState<number[]>(
    new Array(5).fill(0)
  );
  const amplitudeIntervalRef = useRef<number | null>(null);

  const stopSampling = () => {
    if (amplitudeIntervalRef.current !== null) {
      clearInterval(amplitudeIntervalRef.current);
      amplitudeIntervalRef.current = null;
    }
  };

  const handleSubmit = async () => {
    if (audioLoading) return;

    // toggle off if already playing
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        audioRef.current = null;
        setIsPlaying(false);
        setAudioLoaded(false);
        stopSampling();
        quietAvatar();
      }
      return;
    }

    setAudioLoading(true);
    stopSampling();
    // Until her voice starts, the avatar is thinking about what to say.
    avatarBus.setMood("thinking");

    const onError = (err?: unknown) => {
      if (err) console.error("Error playing speech:", err);
      audioRef.current = null;
      setAudioLoading(false);
      setAudioLoaded(false);
      setIsPlaying(false);
      quietAvatar();
      refreshEngineStatus();
      alert("Error generating audio");
    };

    const onPlay = () => {
      avatarBus.setMood("idle");
      refreshEngineStatus();
      amplitudeIntervalRef.current = window.setInterval(() => {
        if (!analyserRef.current) {
          // No level meter on this browser: just keep the bars moving.
          setAmplitudeLevels(
            Array.from({ length: 5 }, () => Math.random() * 0.06)
          );
          return;
        }
        const data = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(data);
        const avg =
          data.reduce((sum, v) => sum + Math.abs(v - 128), 0) /
          analyserRef.current.fftSize;
        setAmplitudeLevels((prev) => [...prev.slice(1), avg / 128]);
      }, 100);
      setIsPlaying(true);
      setAudioLoaded(true);
      setAudioLoading(false);
    };

    const onEnded = () => {
      audioRef.current = null;
      stopSampling();
      setIsPlaying(false);
      quietAvatar();
    };

    try {
      // A clip made earlier for the same script and settings is replayed.
      const ready = appStore.getState().latestAudio;

      // When she is on screen as photo-real video, her voice does not go
      // straight to the speakers: it is played a moment late, in step with
      // her lips, which the GPU box draws on her moving body (LiveTalk).
      const stage = avatarBus.stage;
      if (stage) {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }
        const ctx = audioContextRef.current;
        await ctx.resume();
        analyserRef.current = null;

        // `voice` is the node her voice comes out of; `direct` connects it
        // to the speakers if the video cannot be made after all.
        const withFace = async (voice: AudioNode) => {
          const face = new LiveTalk(stage, { context: ctx, node: voice }, () =>
            voice.connect(ctx.destination)
          );
          await face.start();
          return face;
        };

        if (!ready) {
          const { init } = await speechRequest();
          const player = new StreamPlayer(ctx, null);
          const face = await withFace(player.analyser);
          audioRef.current = {
            pause: () => {
              player.stop();
              face.stop();
            },
          };
          player.onplay = onPlay;
          player.onerror = (err) => {
            face.stop();
            onError(err);
          };
          // Her held-back voice is still playing out when the last of it
          // has been handed over, and a gesture she is in the middle of is
          // drawn to its end.
          player.onended = () =>
            window.setTimeout(async () => {
              await settled(face);
              if (audioRef.current) {
                report("play", face);
                face.stop();
                onEnded();
              }
            }, face.tail);
          player.onaudio = (wav) => appStore.setState({ latestAudio: wav });
          player.start("/api/generate", init);
          return;
        }

        const url = URL.createObjectURL(ready);
        const audio = new Audio(url);
        const face = await withFace(ctx.createMediaElementSource(audio));
        let over = false;
        const finish = () => {
          if (over) return;
          over = true;
          URL.revokeObjectURL(url);
          report("replay", face);
          face.stop();
          onEnded();
        };
        audioRef.current = {
          pause: () => {
            audio.pause();
            finish();
          },
        };
        audio.onplay = onPlay;
        audio.onerror = () => {
          face.stop();
          onError();
        };
        audio.onended = () =>
          window.setTimeout(() => settled(face).then(finish), face.tail);
        await audio.play();
        return;
      }


      if (IS_BLINK && !ready) {
        // Play each chunk as it arrives, and keep the clip for the Voice
        // file button.
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }
        const ctx = audioContextRef.current;
        await ctx.resume();
        const { init } = await speechRequest();
        const player = new StreamPlayer(ctx);
        analyserRef.current = player.analyser;
        releaseVoice.current = avatarBus.attachVoice(player.analyser);
        audioRef.current = player;
        player.onplay = onPlay;
        player.onended = onEnded;
        player.onerror = onError;
        player.onaudio = (wav) => appStore.setState({ latestAudio: wav });
        player.start("/api/generate", init);
        return;
      }

      // Other browsers, and replays: the whole clip in an <audio> element.
      let clip = ready;
      if (!clip) {
        clip = await fetchSpeech((await speechRequest()).init);
        appStore.setState({ latestAudio: clip });
      }
      const url = URL.createObjectURL(clip);
      const audio = new Audio(url);
      analyserRef.current = null;
      // The clip also passes through Web Audio, so the avatar's mouth can
      // follow it. If that is not possible it simply plays as before.
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }
        const ctx = audioContextRef.current;
        await ctx.resume();
        const source = ctx.createMediaElementSource(audio);
        source.connect(ctx.destination);
        releaseVoice.current = avatarBus.attachVoice(source);
      } catch {}
      audioRef.current = audio;
      audio.onplay = onPlay;
      audio.onerror = () => onError();
      audio.onended = () => {
        URL.revokeObjectURL(url);
        onEnded();
      };
      audio.onpause = onEnded;
      await audio.play();
    } catch (err) {
      onError(err);
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
