import { validMotionId } from "@/lib/avatar/motion";
import { gpuKey, rendererFor } from "@/lib/avatarGpu";
import { overLimit } from "@/lib/usage";

export const runtime = "nodejs";

// A best-effort early release of per-utterance GPU state. The renderer
// also expires abandoned turns when a tab disappears without sending this.
export async function POST(req: Request) {
  const id = new URL(req.url).searchParams.get("motion") ?? "";
  if (!validMotionId(id)) return new Response("Invalid motion turn", { status: 400 });
  const limited = overLimit("video", req);
  if (limited) return limited;
  const renderer = await rendererFor();
  if (renderer?.kind === "gpu" && renderer.health.audioPose === true) {
    try {
      await fetch(`${renderer.base}/motion/${id}/end`, {
        method: "POST", headers: { "x-avatar-key": gpuKey() }, signal: AbortSignal.timeout(1500),
      });
    } catch { /* The renderer expires this turn if the connection is gone. */ }
  }
  return new Response(null, { status: 204 });
}
