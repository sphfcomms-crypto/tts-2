"use client";
import dynamic from "next/dynamic";
import React, { useEffect, useRef, useState } from "react";
import { avatarBus } from "@/lib/avatar/bus";
import { canShowVideo, send } from "@/lib/avatar/liveTalk";
import { VideoAvatar } from "./VideoAvatar";

// Her, at the top of the page. While the GPU box is running she is shown
// on photo-real video. When it is not, the 3D character takes her place:
// it is drawn by the browser itself and needs no server.

// The 3D code is large and only runs in the browser: it loads separately.
const Avatar = dynamic(
  () => import("./Avatar").then((module) => module.Avatar),
  { ssr: false }
);

export function AvatarPanel() {
  const [video, setVideo] = useState<boolean | null>(null);
  // The clips the GPU box has prepared, by name.
  const [clips, setClips] = useState<string[]>([]);
  const told = useRef(false);

  useEffect(() => {
    let alive = true;
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
          const onVideo = Boolean(status.video) && canShowVideo();
          // Once per visit: which form of her this device is given, and why.
          if (!told.current) {
            told.current = true;
            send({
              kind: "view",
              view: onVideo ? "video" : "3d",
              gpu: Boolean(status.video),
              canJoinVideo: canShowVideo(),
              clips: names.length,
              direct: Boolean(direct),
            });
          }
          setVideo(onVideo);
        })
        .catch(() => alive && setVideo(false));
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (video === null) return null;
  return video ? <VideoAvatar clips={clips} /> : <Avatar />;
}
