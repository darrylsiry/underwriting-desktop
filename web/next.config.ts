import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Broker submissions arrive as several PDFs; the default 1 MB server-action limit is too small.
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};

export default nextConfig;
