"use client";
import React, { useEffect, useRef, useState } from "react";
import { avatarBus, Mood } from "@/lib/avatar/bus";
import { Director, Unit } from "@/lib/avatar/director";

// Her on video, photo-real.
//
// She is filmed in short clips of body language (listening, nodding, hand
// gestures, a wave, a thoughtful look) that all start and end in the same
// pose. The director plays them back to back on the two lower layers,
// choosing by what she is doing. When she speaks, the GPU box draws her
// lips on the very frames that are playing, and that video shows on the
// top layer (see LiveTalk). The clips are plain files; only the lips need
// the GPU.

const FILES = "/avatar/video";

// Before the body-language clips existed there was one long listening
// loop. It still serves when they are missing or not prepared on the box.
const ONE_LOOP: Unit[] = [
  { name: "talk", frames: 720, pool: "listen", file: `${FILES}/listen.mp4` },
];

type Listing = {
  units?: { name: string; frames: number; pool: Unit["pool"]; mouths?: boolean }[];
};

// clips: the names the GPU box has prepared; only those can carry her lips.
async function loadUnits(clips: string[]): Promise<Unit[]> {
  try {
    const res = await fetch(`${FILES}/units.json`);
    if (!res.ok) return ONE_LOOP;
    const listing = (await res.json()) as Listing;
    const units = (listing.units ?? [])
      .filter((unit) => clips.includes(unit.name) && unit.frames > 0)
      .map((unit) => ({ ...unit, file: `${FILES}/units/${unit.name}.mp4` }));
    return units.some((unit) => unit.pool === "listen") ? units : ONE_LOOP;
  } catch {
    return ONE_LOOP;
  }
}

export function VideoAvatar({ clips }: { clips: string[] }) {
  const talk = useRef<HTMLVideoElement>(null);
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const director = useRef<Director | null>(null);
  const [front, setFront] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [talking, setTalking] = useState(false);
  const [mood, setMood] = useState<Mood>(avatarBus.mood);

  const prepared = clips.join(",");
  useEffect(() => {
    let gone = false;
    let made: Director | null = null;
    loadUnits(prepared.split(",")).then((units) => {
      if (gone) return;
      made = new Director([first.current!, second.current!], units, setFront);
      director.current = made;
      made.start();
      avatarBus.setStage({
        video: talk.current!,
        speaking: setSpeaking,
        talking: setTalking,
        director: made,
      });
    });
    const stop = avatarBus.onMood(setMood);
    return () => {
      gone = true;
      stop();
      made?.stop();
      director.current = null;
      avatarBus.setStage(null);
    };
  }, [prepared]);

  // What her body does next: gestures while she talks, a thoughtful look
  // while an answer is being made, otherwise listening.
  useEffect(() => {
    if (!director.current) return;
    director.current.want = talking ? "talk" : mood === "thinking" ? "think" : "listen";
  }, [talking, mood]);

  const layer = "absolute inset-0 w-full h-full object-cover";

  // A 4:3 picture, like the other side of a video call: the whole frame is
  // shown, at the size it was made, so it stays sharp.
  return (
    <div className="relative mx-auto w-full max-w-[720px] aspect-[4/3] mb-10 rounded-lg overflow-hidden shadow-textarea bg-black">
      <video
        ref={first}
        className={layer}
        style={{ zIndex: front === 0 ? 2 : 1 }}
        poster={`${FILES}/poster.jpg`}
        muted
        playsInline
        preload="auto"
      />
      <video
        ref={second}
        className={layer}
        style={{ zIndex: front === 1 ? 2 : 1 }}
        muted
        playsInline
        preload="auto"
      />
      {/* Her speaking: the same frames with her lips drawn on. It is shown
          the instant it is in step, with no fade, so nothing but her mouth
          is seen to change. */}
      <video
        ref={talk}
        className={layer}
        style={{ zIndex: 3, opacity: speaking ? 1 : 0 }}
        muted
        playsInline
      />
    </div>
  );
}
