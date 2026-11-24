"use client";
import dynamic from "next/dynamic";
import React, { useEffect, useRef, useState } from "react";
import { appStore } from "@/lib/store";
import { avatarBus } from "@/lib/avatar/bus";
import { canShowVideo, send } from "@/lib/avatar/liveTalk";
import { withRendererPreference } from "@/lib/avatar/rendererPreference";
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
  const [wholeFace, setWholeFace] = useState(false);
  // The whole-face server's own look, when it draws one (its address and
  // loop length, so the page reloads her clips only when that changes).
  const [ownLook, setOwnLook] = useState("");

  useEffect(() => {
    let alive = true;
    avatarBus.setVideoAvailable(undefined);
    findHead().then((found) => alive && setHead(found));
    // A live call on the whole-face server is using her stage.
    const holdingCall = () => Boolean(avatarBus.stage?.director.inCall && avatarBus.flash);
    const check = () =>
      fetch(withRendererPreference("/api/avatar/status"))
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
          const fresh = status.flash?.url && status.flash?.token && status.flash?.sliceFrames ? status.flash : null;
          // In a call drawn by the whole-face server her stage is left as it
          // is (taking it down would stop her voice with it), even when the
          // server did not answer or answers at a new address. Only its
          // address and token are brought up to date, for the stream to be
          // tried again on; the rest waits for the first check after the call.
          if (holdingCall()) {
            if (fresh) avatarBus.setFlash(fresh);
            return;
          }
          const flash = fresh;
          // The same for the whole-face server.
          if (flash && flash.url !== avatarBus.flash?.url) {
            fetch(`${flash.url}/health`).catch(() => {});
          }
          avatarBus.setFlash(flash);
          setWholeFace(Boolean(flash));
          setOwnLook(flash?.ownLook ? `${flash.url}|${flash.ownLook.idleFrames}|${flash.ownLook.badge}` : "");
          const names: string[] = Array.isArray(status.clips) ? status.clips : [];
          setClips(before => {
            if (before.join() === names.join()) return before;
            // A call keeps the same playing elements across a GPU/CPU switch
            // when both renderers have the film camera already on screen.
            if (avatarBus.stage?.director.inFilmCall &&
                before.filter(name => name.startsWith("oa1_")).every(name => names.includes(name))) {
              return before;
            }
            return names;
          });
          // The whole-face server draws all of her by itself: the filmed
          // clips then need no lip renderer to be worth showing.
          const available = (Boolean(status.video) || Boolean(flash)) && canShowVideo();
          avatarBus.setVideoAvailable(available);
          setVideo(available);
        })
        .catch(() => {
          if (alive && !avatarBus.stage?.director.inFilmCall && !holdingCall()) {
            avatarBus.setVideoAvailable(false);
            setVideo(false);
          }
        });
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      avatarBus.setVideoAvailable(false);
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
  if (video && !local) {
    return <VideoAvatar clips={clips} everyClip={wholeFace && clips.length === 0} ownLook={ownLook} />;
  }
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
