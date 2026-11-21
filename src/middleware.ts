import { NextRequest, NextResponse } from "next/server";

// Optional lock for the public server. When APP_PASSWORD is set in .env,
// the production server asks every visitor for it (the browser shows its
// own sign-in box; any user name works) before serving anything. With no
// APP_PASSWORD the app is open, protected only by the usage caps in
// src/lib/usage.ts. The development server is never locked.

function sameText(a: string, b: string): boolean {
  // Compare in constant time so the password cannot be guessed by timing.
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password || process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }
  // The avatar's GPU box announces itself here with its own secret key.
  if (req.nextUrl.pathname === "/api/avatar/register") {
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
      if (sameText(given, password)) return NextResponse.next();
    } catch {}
  }

  return new NextResponse("Password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TTS", charset="UTF-8"' },
  });
}

export const config = {
  matcher: "/:path*",
};
