import { flashAccess } from "@/lib/avatarFlash";
import { browserAccess, rendererFor } from "@/lib/avatarGpu";

// Tells the page whether her video can be made right now: the GPU box is
// rented by the hour, so it is not always there.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cpu = new URL(request.url).searchParams.get("renderer") === "cpu";
  const [renderer, flash] = await Promise.all([rendererFor(undefined, cpu), flashAccess()]);
  const clips = renderer?.health.clips ?? [];
  return Response.json(
    {
      video: clips.length > 0,
      // The clips of her the box has prepared: her lips can be drawn on these.
      clips: clips.map((clip) => clip.name),
      // Where the browser fetches her video itself, and its pass for now.
      direct: renderer?.kind === "gpu" ? browserAccess(renderer.health.audioPose === true) : null,
      renderer: renderer?.kind ?? null,
      // The whole-face server, when one is running: in a live call her head
      // and shoulders are then drawn new for every picture.
      flash,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
