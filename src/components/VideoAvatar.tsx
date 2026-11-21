"use client";
import React, { useEffect, useRef, useState } from "react";
import { avatarBus, Mood } from "@/lib/avatar/bus";

// Her on video, photo-real. Three layers of the same woman in the same
// seat:
//   - listen: a loop of her listening, always running underneath;
//   - think: a loop of her thinking, shown between Play and her first word;
//   - talk: her speaking, drawn on the GPU box with her lips matched to the
//     voice, arriving piece by piece (see TalkPlayer and LiveTalk).
// The loops are plain files; only the talking needs the GPU.
//
// The talking is drawn on the same clip as the listening loop, frame for
// frame, so going from one to the other is the same take with her mouth
// opening or closing, not a cut to another picture.

const FILES = "/avatar/video";

export function VideoAvatar() {
  const talk = useRef<HTMLVideoElement>(null);
  const think = useRef<HTMLVideoElement>(null);
  const base = useRef<HTMLVideoElement>(null);
  const [following, setFollowing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [mood, setMood] = useState<Mood>(avatarBus.mood);

  useEffect(() => {
    avatarBus.setStage({
      video: talk.current!,
      speaking: setSpeaking,
      base: base.current!,
      follow: setFollowing,
    });
    const stop = avatarBus.onMood(setMood);
    return () => {
      stop();
      avatarBus.setStage(null);
    };
  }, []);

  // A script plays from the first frame of the clip: the loop underneath
  // is kept on the frame the talking video shows.
  useEffect(() => {
    if (!following) return;
    const timer = window.setInterval(() => {
      const loop = base.current;
      const speech = talk.current;
      // Only while her talking video is really moving: when it is waiting
      // for its next piece the loop is what is seen, and it must run free.
      if (!loop || !speech || !loop.duration || speech.paused || speech.readyState < 3) return;
      const want = speech.currentTime % loop.duration;
      if (Math.abs(loop.currentTime - want) > 0.06) loop.currentTime = want;
    }, 200);
    return () => window.clearInterval(timer);
  }, [following]);

  const thinking = mood === "thinking" && !speaking;
  useEffect(() => {
    const video = think.current;
    if (!video) return;
    if (thinking) {
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      // Left running until it has faded out.
      const timer = window.setTimeout(() => video.pause(), 400);
      return () => window.clearTimeout(timer);
    }
  }, [thinking]);

  const layer = "absolute inset-0 w-full h-full object-cover transition-opacity duration-300";
  const framing = { objectPosition: "50% 30%" };

  // A 4:3 picture, like the other side of a video call: the whole frame is
  // shown, at the size it was made, so it stays sharp.
  return (
    <div className="relative mx-auto w-full max-w-[720px] aspect-[4/3] mb-10 rounded-lg overflow-hidden shadow-textarea bg-black">
      <video
        ref={base}
        className={layer}
        style={framing}
        src={`${FILES}/listen.mp4`}
        poster={`${FILES}/poster.jpg`}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
      />
      <video
        ref={think}
        className={layer}
        style={{ ...framing, opacity: thinking ? 1 : 0 }}
        src={`${FILES}/think.mp4`}
        loop
        muted
        playsInline
        preload="auto"
      />
      <video
        ref={talk}
        className={layer}
        style={{ ...framing, opacity: speaking ? 1 : 0 }}
        playsInline
      />
    </div>
  );
}
