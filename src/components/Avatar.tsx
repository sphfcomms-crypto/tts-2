"use client";
import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Manifest, Performer } from "@/lib/avatar/performer";

// Her, on screen: the 3D character built in Blender (public/avatar), drawn
// here and brought to life by the Performer. If the model file is missing
// nothing is shown: there is no stand-in figure.

const MODEL = "/avatar/avatar.glb";
const MANIFEST = "/avatar/avatar.json";

type Loaded = {
  // Handles for looking at her from the browser console while developing.
  parts: Record<string, unknown>;
  stop: () => void;
};

// `gone` says whether the page has already let go of this avatar. It is
// checked before anything is drawn: two renderers must never share one
// canvas (each would spoil the other's picture).
async function start(
  canvas: HTMLCanvasElement,
  holder: HTMLElement,
  gone: () => boolean
): Promise<Loaded | null> {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(MODEL),
    fetch(MANIFEST)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({})) as Promise<Manifest>,
  ]);

  if (gone()) return null;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  // Soft light from all round, as in a photo studio.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const model = gltf.scene;
  scene.add(model);
  model.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(model);
  const height = box.max.y - box.min.y;

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    // The stored bounds are for the bind pose; she moves.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials as THREE.MeshStandardMaterial[]) {
      for (const map of [material.map, material.normalMap, material.roughnessMap]) {
        if (map) map.anisotropy = anisotropy;
      }
      const name = `${material.name} ${mesh.name}`.toLowerCase();
      const cutOut = material.transparent || material.alphaTest > 0;
      if (cutOut && /hair|lash|brow/.test(name)) {
        // Strands with soft edges, blended, but still written to the depth
        // buffer so the layers of hair do not show through each other.
        // (Drawing them through the antialiasing samples instead left the
        // top of her head see-through.)
        material.transparent = true;
        material.alphaTest = 0.08;
        material.depthWrite = true;
        material.side = THREE.DoubleSide;
        mesh.renderOrder = 2;
      }
      material.needsUpdate = true;
    }
  });

  // Key light from the front, a little to one side and above, with soft
  // shadows; a cool rim from behind lifts her off the background.
  const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
  key.position.set(0.9, height * 1.25, 2.2);
  key.target.position.set(0, height * 0.85, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.012;
  key.shadow.radius = 5;
  const reach = height * 0.75;
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.1, far: 8 });
  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.5);
  rim.position.set(-1.4, height * 1.2, -1.8);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-1.5, height * 0.8, 1.6);
  scene.add(key, key.target, rim, fill);

  // From mid-chest to just above her head, the same framing as her video,
  // with a long lens (kind to a face).
  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 30);
  const eyes = manifest.eyeHeight ?? box.min.y + height * 0.93;
  const target = new THREE.Vector3(0, eyes - 0.1, 0);
  const span = 0.56; // metres of her shown, top to bottom
  camera.position.set(0, target.y + 0.02, span / 2 / Math.tan((camera.fov * Math.PI) / 360));
  const distance = camera.position.distanceTo(target);
  const direction = camera.position.clone().sub(target).normalize();

  const resize = () => {
    const width = holder.clientWidth;
    const heightPx = holder.clientHeight;
    if (!width || !heightPx) return;
    renderer.setSize(width, heightPx, false);
    camera.aspect = width / heightPx;
    // A narrow (phone) frame steps back so her shoulders stay in view.
    const fit = Math.max(1, 1.1 / camera.aspect);
    camera.position.copy(target).addScaledVector(direction, distance * fit);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(holder);
  resize();

  const performer = new Performer(model, manifest);
  const clock = new THREE.Clock();
  let frame = 0;
  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  });
  watcher.observe(holder);

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    // Off screen or in a background tab she is not drawn.
    if (!visible || document.hidden) return;
    performer.update(dt);
    renderer.render(scene, camera);
  };
  tick();

  return {
    parts: { scene, camera, renderer, model, performer, target },
    stop: () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      watcher.disconnect();
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials as THREE.MeshStandardMaterial[]) {
          material.map?.dispose();
          material.normalMap?.dispose();
          material.roughnessMap?.dispose();
          material.dispose();
        }
      });
      scene.environment?.dispose();
      renderer.dispose();
    },
  };
}

export function Avatar() {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    let loaded: Loaded | null = null;
    let gone = false;
    start(canvas.current!, holder.current!, () => gone)
      .then((result) => {
        if (!result) return;
        if (gone) return result.stop();
        loaded = result;
        if (process.env.NODE_ENV !== "production") {
          Object.assign(window, { __avatar: result.parts });
        }
        setState("ready");
      })
      .catch((err) => {
        console.error("The avatar could not be loaded:", err);
        if (!gone) setState("missing");
      });
    return () => {
      gone = true;
      loaded?.stop();
    };
  }, []);

  if (state === "missing") return null;

  return (
    <div
      ref={holder}
      className="relative mx-auto w-full max-w-[720px] aspect-[4/3] mb-10 rounded-lg overflow-hidden shadow-textarea"
      style={{
        background:
          "radial-gradient(120% 90% at 50% 35%, #d9dcdd 0%, #b9bdbf 55%, #9a9ea1 100%)",
      }}
    >
      <canvas
        ref={canvas}
        className="block w-full h-full transition-opacity duration-700"
        style={{ opacity: state === "ready" ? 1 : 0 }}
      />
      {state === "loading" && (
        <span className="absolute inset-0 flex items-center justify-center uppercase opacity-50">
          Loading…
        </span>
      )}
    </div>
  );
}
