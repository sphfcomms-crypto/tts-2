import { browserAccess, rendererFor } from "@/lib/avatarGpu";

// Tells the page whether her video can be made right now: the GPU box is
// rented by the hour, so it is not always there.

export const dynamic = "force-dynamic";

export async function GET() {
  const renderer = await rendererFor();
  const clips = renderer?.health.clips ?? [];
  return Response.json(
    {
      video: clips.length > 0,
      // The clips of her the box has prepared: her lips can be drawn on these.
      clips: clips.map((clip) => clip.name),
      // Where the browser fetches her video itself, and its pass for now.
      direct: renderer?.kind === "gpu" ? browserAccess() : null,
      renderer: renderer?.kind ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
