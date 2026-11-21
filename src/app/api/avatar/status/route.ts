import { browserAccess, gpuHealth } from "@/lib/avatarGpu";

// Tells the page whether her video can be made right now: the GPU box is
// rented by the hour, so it is not always there.

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await gpuHealth();
  const talk = health?.clips?.find((clip) => clip.name === "talk");
  return Response.json(
    {
      video: Boolean(health && talk),
      width: talk?.width,
      height: talk?.height,
      // Where the browser fetches her video itself, and its pass for now.
      direct: health && talk ? browserAccess() : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
