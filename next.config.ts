import type { NextConfig } from "next";

const IS_DEV = process.env.NODE_ENV !== "production";

const CSP = [
  "default-src 'self';",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' ;",
  // blob: the avatar's textures are unpacked from its model file in memory,
  // and a clip that is replayed is held in memory too.
  // The avatar's GPU box hands her video to the browser directly, through
  // its own tunnel address (it changes every time the box starts).
  "connect-src 'self' blob: https://*.trycloudflare.com;",
  "media-src 'self' blob:;",
  "style-src 'self' 'unsafe-inline';",
  "img-src 'self' blob: data:;",
  "object-src 'none';",
  "frame-ancestors 'none';",
  IS_DEV ? null : "upgrade-insecure-requests;",
]
  .filter(Boolean)
  .join(" ");

const nextConfig: NextConfig = {
  // The production build goes to its own folder (NEXT_DIST_DIR=.next-prod),
  // so building or running it never disturbs the development server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  devIndicators: false,

  // Apply the same SVG transform to the webpack-based production build
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/i,
      issuer: /\.[jt]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
  async headers() {
    const headers = [
      {
        key: "Content-Security-Policy",
        value: CSP,
      },
    ];

    if (!IS_DEV) {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains; preload",
      });
    }

    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;
