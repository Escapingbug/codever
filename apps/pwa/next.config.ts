import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the Sites/Worker build as the default while allowing the same PWA to
  // be packaged with its minimal Node runtime for a self-hosted deployment.
  output: process.env.CODEVER_PWA_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
