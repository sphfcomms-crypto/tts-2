"use client";
import dynamic from "next/dynamic";
import React, { useEffect, useRef, useState } from "react";
import { appStore } from "@/lib/store";
import { avatarBus } from "@/lib/avatar/bus";
import { canShowVideo, send } from "@/lib/avatar/liveTalk";
import { VideoAvatar } from "./VideoAvatar";

// Her, at the top of the page, in the best form that can be shown:
//   1. on photo-real video with body language, while a GPU box is running;
//   2. as a photo-real 3D head drawn by the browser itself (no server),
//      when that head has been made (public/avatar/head/avatar.zip);
//   3. as the Blender-built 3D character, drawn by the browser too.

// The 3D code is large and only runs in the browser: it loads separately.
const Avatar = dynamic(
  () => import("./Avatar").then((module) => module.Avatar),
  { ssr: false }
);
const HeadAvatar = dynamic(
  () => import("./HeadAvatar").then((module) => module.HeadAvatar),
  { ssr: false }
);

// Her photo-real head, and (while developing only) LAM's own sample head to
// try the renderer with before hers exists.
const HEADS = [
  "/avatar/head/avatar.zip",
  ...(process.env.NODE_ENV !== "production" ? ["/avatar/head/sample.zip"] : []),
];

// The first of the head files that is there, or "" when none is.
async function findHead(): Promise<string> {
  for (const head of HEADS) {
    try {
      const res = await fetch(head, { method: "HEAD" });
      const type = res.headers.get("content-type") || "";
      if (res.ok && !type.includes("text/html")) return head;
    } catch {}
  }
  return "";
}

export function AvatarPanel() {
  const localScriptAvatar = appStore.useState((state) => state.localScriptAvatar);
  const localCallAvatar = appStore.useState((state) => state.localCallAvatar);
  const [video, setVideo] = useState<boolean | null>(null);
  // The clips the GPU box has prepared, by name.
  const [clips, setClips] = useState<string[]>([]);
  // The file of her photo-real head: null until looked for, "" if absent.
  const [head, setHead] = useState<string | null>(null);
  const told = useRef(false);

  useEffect(() => {
    let alive = true;
    findHead().then((found) => alive && setHead(found));
    const check = () =>
      fetch("/api/avatar/status")
        .then((res) => (res.ok ? res.json() : { video: false }))
        .then((status) => {
          if (!alive) return;
          const direct = status.direct?.url && status.direct?.token ? status.direct : null;
          // Opening the connection to the GPU box now saves about a second
          // when she first speaks. (The answer itself does not matter.)
          if (direct && direct.url !== avatarBus.direct?.url) {
            fetch(`${direct.url}/piece/hello`).catch(() => {});
          }
          avatarBus.setDirect(direct);
          const names: string[] = Array.isArray(status.clips) ? status.clips : [];
          setClips((before) => (before.join() === names.join() ? before : names));
          setVideo(Boolean(status.video) && canShowVideo());
        })
        .catch(() => alive && setVideo(false));
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Once per visit: which form of her this device is given, and why.
  useEffect(() => {
    if (told.current || video === null || head === null) return;
    told.current = true;
    send({
      kind: "view",
      view: video ? "video" : head ? "head" : "3d",
      gpu: clips.length > 0,
      canJoinVideo: canShowVideo(),
      clips: clips.length,
      direct: Boolean(avatarBus.direct),
    });
  }, [video, head, clips]);

  const local = localCallAvatar || localScriptAvatar;
  if (head === null || (video === null && !local)) return null;
  if (video && !local) return <VideoAvatar clips={clips} />;
  return (
    <>
      {head ? <HeadAvatar asset={head} onFail={() => setHead("")} /> : <Avatar />}
      {localCallAvatar && (
        <p role="status" className="text-center text-sm">
          On-device animation is following the live call audio.
        </p>
      )}
    </>
  );
}
