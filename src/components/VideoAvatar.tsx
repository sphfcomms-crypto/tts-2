"use client";
import React, { useEffect, useRef, useState } from "react";
import { avatarBus, type Flash, Mood } from "@/lib/avatar/bus";
import { Director, DISSOLVE, fromFilm, Unit } from "@/lib/avatar/director";

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
    cue?: Unit["cue"];
    weight?: number;
    mouths?: boolean;
    rise?: number;
    release?: number;
  }[];
};

// clips: the names the GPU box has prepared; only those can carry her lips.
// everyClip: no lip renderer is running, but the whole-face server is. Her
// clips need no preparing then. Of them, those filmed from the picture
// that server draws her from are used, and no others: in a call her head
// is drawn over them, and between calls she then sits in the same seat,
// so nothing jumps when a call begins.
async function listUnits(clips: string[], everyClip: boolean): Promise<Unit[]> {
  try {
    const res = await fetch(`${FILES}/units.json`, { cache: "no-store" });
    if (!res.ok) return oneLoop();
    const listing = (await res.json()) as Listing;
    let units = (listing.units ?? [])
      .filter((unit) => (everyClip || clips.includes(unit.name)) && unit.frames > 0)
      .map((unit) => ({ ...unit, file: `${FILES}/units/${unit.name}.mp4` }));
    const film = units.filter(fromFilm);
    if (everyClip && film.some((unit) => unit.pool === "listen") && film.some((unit) => unit.pool === "talk")) {
      units = film;
    }
    return units.some((unit) => unit.pool === "listen") ? units : oneLoop();
  } catch {
    return oneLoop();
  }
}

// The whole-face server's own look: its loop of her listening quietly is the
// only clip. It is the same picture as the server's frames, so the stream
// can be shown whole over it and nothing jumps when a call begins.
export function ownLookUnits(flash: Flash): Unit[] {
  if (!flash.ownLook) return [];
  return [{
    name: "flash_idle",
    frames: flash.ownLook.idleFrames,
    pool: "listen",
    also: ["idle", "think", "talk", "greet"],
    file: `${flash.url}/idle.mp4?t=${encodeURIComponent(flash.token)}`,
  }];
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

// A live broadcast's marks, for the news look: LIVE, and the viewer's own time.
function NewsBadge() {
  const now = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const [time, setTime] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <span
        className="absolute left-3 top-3 rounded-sm bg-[#d0021b] px-2 py-0.5 text-xs font-bold tracking-wider text-white"
        style={{ zIndex: 5 }}
      >
        LIVE
      </span>
      <span
        className="absolute right-3 top-3 text-sm font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.7)]"
        style={{ zIndex: 5 }}
      >
        {time}
      </span>
    </>
  );
}

// ownLook: set while the whole-face server draws her in a look of its own
// (see ownLookUnits); it changes when that server or its loop does.
export function VideoAvatar({
  clips,
  everyClip = false,
  ownLook = "",
}: {
  clips: string[];
  everyClip?: boolean;
  ownLook?: string;
}) {
  const talk = useRef<HTMLVideoElement>(null);
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const director = useRef<Director | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [filmCamera, setFilmCamera] = useState(false);
  const [talking, setTalking] = useState(false);
  const [mood, setMood] = useState<Mood>(avatarBus.mood);
  const [poster, setPoster] = useState("");
  const own = ownLook ? avatarBus.flash : null;
  const badge = own?.ownLook?.badge ?? "";

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
      setFilmCamera(Boolean(top.dataset.unit?.startsWith("oa1_")));
      top.style.zIndex = "2";
      under.style.zIndex = "1";
      if (soft) top.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DISSOLVE, easing: "linear" });
    };

    const look = ownLook ? avatarBus.flash : null;
    if (look?.ownLook) {
      // Her picture at once, while the loop is on its way.
      fetch(`${look.url}/still.jpg?t=${encodeURIComponent(look.token)}`)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (gone || !blob) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPoster(url);
        })
        .catch(() => {});
    }
    const listed = look?.ownLook ? Promise.resolve(ownLookUnits(look)) : listUnits(prepared.split(","), everyClip);
    listed.then(async (units) => {
      if (gone) return;
      made = new Director(players, units, show, () => avatarBus.phrase);
      // What she is doing at this moment (the effect below only hears of changes).
      made.want =
        avatarBus.mood === "thinking" ? "think" : avatarBus.mood === "listening" ? "listen" : "idle";
      director.current = made;
      const hasFilm = units.some(unit => unit.cue) && units.some(unit => unit.name === "oa1_listen_neutral");
      let published = false;
      const begin = (finished = false) => {
        if (gone || !made || published) return;
        if (!units.some((unit) => unit.url && unit.pool === "listen")) return;
        if (!made.running) made.start();
        if (hasFilm && !finished && !made.filmReady) return;
        published = true;
        avatarBus.setStage({
          video: talk.current!,
          speaking: setSpeaking,
          talking: setTalking,
          director: made,
        });
      };
      // Two at a time, in the order she needs them. She starts as soon as
      // she has one clip to listen in; the others join as they arrive.
      const priority = (unit: Unit) => unit.name === "oa1_listen_neutral" ? -4 :
        unit.cue === "reflect" || unit.cue === "explain" ? -3 :
        unit.cue ? -2 : ORDER.indexOf(unit.pool);
      const queue = [...units].sort((a, b) => priority(a) - priority(b));
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
      begin(true);
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
      setPoster("");
    };
  }, [prepared, everyClip, ownLook]);

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
      style={{
        backgroundImage: own
          ? poster ? `url(${poster})` : "none"
          : `url(${FILES}/${everyClip || clips.includes("oa1_listen_neutral") ? "oa1-poster.jpg" : "poster.jpg"})`,
      }}
    >
      <video ref={first} className={layer} style={{ zIndex: 2 }} muted playsInline preload="auto" />
      <video ref={second} className={layer} style={{ zIndex: 1 }} muted playsInline preload="auto" />
      {/* MuseTalk already composites the mouth into its exact source frame.
          Show that whole frame so the chin, eyes, neck and shoulders always
          belong to the same instant, including during a seek or head turn. */}
      <video
        ref={talk}
        className={layer}
        style={{
          zIndex: 3,
          opacity: speaking ? 1 : 0,
        }}
        muted
        playsInline
      />
      {/* The room: one still picture laid over everything outside the zone
          she moves in. It is not video, so it cannot flicker or shift from
          clip to clip. (Made by avatar-build/video/units/lock_background.py.) */}
      {/* (Not in a look of the server's own: that is another room.) */}
      {!own && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${FILES}/room.webp`}
          alt=""
          draggable={false}
          className={`${layer} pointer-events-none select-none`}
          style={{ zIndex: 4, visibility: speaking || filmCamera ? "hidden" : "visible" }}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
      {own && badge === "news" && <NewsBadge />}
    </div>
  );
}
