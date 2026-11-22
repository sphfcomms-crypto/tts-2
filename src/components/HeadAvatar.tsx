"use client";
import React, { useEffect, useRef, useState } from "react";
import { Face } from "@/lib/avatar/face";

// Her as a photo-real 3D head, drawn by the browser itself: no server.
//
// The head was made from one picture of her by LAM (a model that turns a
// portrait into an animatable head of "Gaussian splats": millions of tiny
// soft dots, which is why it looks like the photograph and not like a
// mesh). It is stored in one file and drawn by LAM's own WebGL renderer.
// The renderer is given two things every frame: what she is doing (it
// moves her head to suit) and the fifty-two face shapes from Face, which
// follow her voice.

// The renderer films her from a fixed spot with a wide lens, which leaves
// her small in the picture. A longer lens (a smaller angle) fills the frame
// with her head and shoulders, as a portrait would.
const LENS = 24;

// Of the picture that lens gives, the part that is shown, as shares of its
// width and height: from just above her hair down to her collarbone. (The
// model makes a head and neck; below that her shoulders are a smear.)
const CROP = { left: 0.14, top: 0.035, size: 0.72 };

type Viewer = {
  camera?: {
    fov: number;
    updateProjectionMatrix: () => void;
    setViewOffset: (
      fullWidth: number,
      fullHeight: number,
      x: number,
      y: number,
      width: number,
      height: number
    ) => void;
  } | null;
  controls?: { enabled: boolean; stopListenToKeyEvents?: () => void } | null;
  sceneRevealMode?: number;
};
// The renderer's own way of showing a scene at once (its SceneRevealMode.Instant).
const AT_ONCE = 2;

function frame(renderer: { viewer?: Viewer } | null) {
  const viewer = renderer?.viewer;
  if (!viewer) return;
  // By default she grows out of a blur over a few hundred frames, which on
  // a slow phone is many seconds of a smeared face.
  viewer.sceneRevealMode = AT_ONCE;
  if (viewer.camera) {
    viewer.camera.fov = LENS;
    viewer.camera.setViewOffset(1, 1, CROP.left, CROP.top, CROP.size, CROP.size);
    viewer.camera.updateProjectionMatrix();
  }
  // She is not to be turned round with the mouse or the arrow keys.
  if (viewer.controls) {
    viewer.controls.enabled = false;
    viewer.controls.stopListenToKeyEvents?.();
  }
}

// onFail: this device cannot draw her head (no WebGL 2, say); the page then
// shows her in another form.
export function HeadAvatar({ asset, onFail }: { asset: string; onFail: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const failed = useRef(onFail);
  failed.current = onFail;

  useEffect(() => {
    let gone = false;
    let renderer: { dispose: () => void; viewer?: Viewer } | null = null;
    let lam: typeof import("gaussian-splat-renderer-for-lam") | null = null;
    const face = new Face();
    let last = performance.now();

    (async () => {
      try {
        // The renderer is large and needs a browser: it loads separately.
        lam = await import("gaussian-splat-renderer-for-lam");
        if (gone) return;
        renderer = await lam.GaussianSplatRenderer.getInstance(holder.current!, asset, {
          getChatState: () => face.doing,
          // Asked once per frame drawn.
          getExpressionData: () => {
            const now = performance.now();
            const weights = face.update((now - last) / 1000);
            last = now;
            return weights;
          },
          // Drawn on a clear canvas, so the backdrop behind her is the
          // page's own (a soft studio wall, below).
          backgroundColor: "0xd6d9da",
          alpha: 0,
        });
        // The renderer reports its own errors and then returns nothing.
        if (!renderer) throw new Error("the head renderer did not start");
        if (gone) {
          // The visitor left while she was loading.
          renderer?.dispose();
          return;
        }
        frame(renderer);
        if (process.env.NODE_ENV !== "production") {
          Object.assign(window, { __head: renderer });
        }
        setReady(true);
      } catch (err) {
        console.error("Her 3D head could not be shown:", err);
        if (!gone) failed.current();
      }
    })();

    return () => {
      gone = true;
      try {
        renderer?.dispose();
      } catch {}
      // The renderer keeps the one it made; let the next visit make a new one.
      if (lam) lam.GaussianSplatRenderer.instance = undefined;
    };
  }, [asset]);

  return (
    <div className="relative mx-auto w-full max-w-[720px] aspect-[4/3] mb-10 rounded-lg overflow-hidden shadow-textarea bg-[radial-gradient(ellipse_at_50%_38%,#e9ebeb_0%,#d6d9da_48%,#b9bebf_100%)]">
      {/* Her lower edge melts into the wall behind her instead of ending in a cut. */}
      <div
        ref={holder}
        className="absolute inset-0 pointer-events-none [mask-image:linear-gradient(to_bottom,black_80%,transparent_99%)]"
      />
      {!ready && (
        <span className="absolute inset-0 flex items-center justify-center uppercase opacity-50">
          Loading…
        </span>
      )}
    </div>
  );
}
