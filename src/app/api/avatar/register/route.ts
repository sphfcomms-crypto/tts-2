import { NextRequest } from "next/server";
import { keyMatches, setGpuAddress } from "@/lib/avatarGpu";

// The GPU box calls this when it starts, to say where it can be reached.
//
//   POST /api/avatar/register   { "url": "https://….trycloudflare.com" }
//   header x-avatar-key: the shared secret

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!keyMatches(req.headers.get("x-avatar-key"))) {
    return new Response("Not allowed", { status: 401 });
  }
  let url = "";
  try {
    url = String((await req.json()).url ?? "");
  } catch {}
  if (!setGpuAddress(url)) {
    return new Response("That address is not accepted", { status: 400 });
  }
  return Response.json({ ok: true });
}
