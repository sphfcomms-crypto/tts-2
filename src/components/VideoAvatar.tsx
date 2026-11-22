"use client";
import React, { useEffect, useRef, useState } from "react";
import { avatarBus, Mood } from "@/lib/avatar/bus";
import { Director, DISSOLVE, Unit } from "@/lib/avatar/director";

// Her on video, photo-real.
//
// She is filmed in short clips of body language (listening, nodding, hand
// gestures, a wave, a thoughtful look) that all start and end in the same
// pose. The director plays them on the two lower layers, choosing by what
// she is doing. When she speaks, the GPU box draws her lips on the very
// frames that are playing, and that video shows on the top layer (see
// LiveTalk). The clips are plain files; only the lips need the GPU.
//
// The clips are fetched whole and played from memory. Streamed, a clip
// needs the line to be faster than the clip plays, and the app's own line
// is not (it was measured at 150 to 235 KB/s against 200 KB/s of video):
// she froze. They are fetched from the GPU box's own address when it has
// them, which is many times faster, and from the app otherwise.

const FILES = "/avatar/video";

// Where her face can be, in any clip: only there is the video of her
// speaking shown. Everything else stays the clip underneath, so that when
// she speaks nothing changes but her face (the speaking video is coded
// more lightly, and showing all of it made the whole picture shift).
// An ellipse, given as shares of the picture, with a soft edge.
const FACE = "radial-gradient(ellipse 10.4% 13.9% at 50.2% 30.8%, #000 70%, transparent 100%)";

// Before the body-language clips existed there was one long listening
// loop. It still serves when they are missing or not prepared on the box.
const oneLoop = (): Unit[] => [
  { name: "talk", frames: 720, pool: "listen", file: `${FILES}/listen.mp4` },
];

type Listing = {
  units?: {
    name: string;
    frames: number;
    pool: Unit["pool"];
    also?: Unit["pool"][];
    weight?: number;
    mouths?: boolean;
    rise?: number;
    release?: number;
  }[];
};

// clips: the names the GPU box has prepared; only those can carry her lips.
async function listUnits(clips: string[]): Promise<Unit[]> {
  try {
    const res = await fetch(`${FILES}/units.json`);
    if (!res.ok) return oneLoop();
    const listing = (await res.json()) as Listing;
    const units = (listing.units ?? [])
      .filter((unit) => clips.includes(unit.name) && unit.frames > 0)
      .map((unit) => ({ ...unit, file: `${FILES}/units/${unit.name}.mp4` }));
    return units.some((unit) => unit.pool === "listen") ? units : oneLoop();
  } catch {
    return oneLoop();
  }
}

// One clip, whole, from the GPU box if it answers quickly, else from the app.
async function fetchClip(unit: Unit): Promise<Blob> {
  const direct = avatarBus.direct;
  if (direct && unit.file.includes("/units/")) {
    try {
      const res = await fetch(`${direct.url}/clip/${unit.name}.mp4`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 10_000) return new Blob([blob], { type: "video/mp4" });
      }
    } catch {}
  }
  const res = await fetch(unit.file);
  if (!res.ok) throw new Error(`clip ${unit.name} is missing`);
  return new Blob([await res.blob()], { type: "video/mp4" });
}

// What she needs first comes first: something to sit and listen in.
const ORDER: Unit["pool"][] = ["listen", "idle", "think", "talk", "greet"];

export function VideoAvatar({ clips }: { clips: string[] }) {
  const talk = useRef<HTMLVideoElement>(null);
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const director = useRef<Director | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [talking, setTalking] = useState(false);
  const [mood, setMood] = useState<Mood>(avatarBus.mood);

  const prepared = clips.join(",");
  useEffect(() => {
    let gone = false;
    let made: Director | null = null;
    const urls: string[] = [];
    const players: [HTMLVideoElement, HTMLVideoElement] = [first.current!, second.current!];

    // Brings one of the two players to the front, at once or through a
    // dissolve (when the picture before it is in another pose).
    const show = (front: number, soft: boolean) => {
      const top = players[front];
      const under = players[1 - front];
      top.style.zIndex = "2";
      under.style.zIndex = "1";
      if (soft) top.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DISSOLVE, easing: "linear" });
    };

    listUnits(prepared.split(",")).then(async (units) => {
      if (gone) return;
      made = new Director(players, units, show, () => avatarBus.phrase);
      // What she is doing at this moment (the effect below only hears of changes).
      made.want =
        avatarBus.mood === "thinking" ? "think" : avatarBus.mood === "listening" ? "listen" : "idle";
      director.current = made;
      const begin = () => {
        if (gone || !made || made.running) return;
        if (!units.some((unit) => unit.url && unit.pool === "listen")) return;
        made.start();
        avatarBus.setStage({
          video: talk.current!,
          speaking: setSpeaking,
          talking: setTalking,
          director: made,
        });
      };
      // Two at a time, in the order she needs them. She starts as soon as
      // she has one clip to listen in; the others join as they arrive.
      const queue = [...units].sort((a, b) => ORDER.indexOf(a.pool) - ORDER.indexOf(b.pool));
      const worker = async () => {
        for (let unit = queue.shift(); unit && !gone; unit = queue.shift()) {
          try {
            const blob = await fetchClip(unit);
            if (gone) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            unit.url = url;
            begin();
          } catch {}
        }
      };
      await Promise.all([worker(), worker()]);
    });
    const stop = avatarBus.onMood(setMood);
    return () => {
      gone = true;
      stop();
      made?.stop();
      director.current = null;
      avatarBus.setStage(null);
      for (const player of players) {
        player.removeAttribute("src");
        player.load();
      }
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [prepared]);

  // What her body does next: a thoughtful look while an answer is being
  // made, otherwise listening. (That she has begun to speak, the lip sync
  // tells the director itself, with the moment her voice will be heard.)
  useEffect(() => {
    const want = talking ? "talk" : mood === "thinking" ? "think" : mood === "listening" ? "listen" : "idle";
    // LiveTalk already planned the speech onset at an audio-clock deadline.
    if (director.current && director.current.want !== want) director.current.turn(want);
  }, [talking, mood]);

  const layer = "absolute inset-0 w-full h-full object-cover";

  // A 4:3 picture, like the other side of a video call: the whole frame is
  // shown, at the size it was made, so it stays sharp.
  return (
    <div
      className="relative mx-auto w-full max-w-[720px] aspect-[4/3] mb-10 rounded-lg overflow-hidden shadow-textarea bg-black bg-cover bg-center"
      style={{ backgroundImage: `url(${FILES}/poster.jpg)` }}
    >
      <video ref={first} className={layer} style={{ zIndex: 2 }} muted playsInline preload="auto" />
      <video ref={second} className={layer} style={{ zIndex: 1 }} muted playsInline preload="auto" />
      {/* Her speaking: the same frames with her lips drawn on. It comes and
          goes in a few frames, so that a change of clip underneath is not
          seen as a jump. */}
      <video
        ref={talk}
        className={layer}
        style={{
          zIndex: 3,
          opacity: speaking ? 1 : 0,
          transition: "opacity 40ms linear",
          WebkitMaskImage: FACE,
          maskImage: FACE,
        }}
        muted
        playsInline
      />
      {/* The room: one still picture laid over everything outside the zone
          she moves in. It is not video, so it cannot flicker or shift from
          clip to clip. (Made by avatar-build/video/units/lock_background.py.) */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${FILES}/room.webp`}
        alt=""
        draggable={false}
        className={`${layer} pointer-events-none select-none`}
        style={{ zIndex: 4 }}
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
    </div>
  );
}
