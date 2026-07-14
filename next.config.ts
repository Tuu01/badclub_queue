import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Testing on a real phone over LAN — Next.js blocks /_next/* asset
  // requests from any origin but localhost unless explicitly allowed.
  // Without this, the page shell (static HTML) loads fine but
  // everything after it (JS chunks, hydration) silently hangs, which
  // looks exactly like "stuck at loading."
  allowedDevOrigins: ['192.168.0.14'],
};

export default nextConfig;
