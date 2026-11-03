import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Broker submissions arrive as several PDFs; the default 1 MB server-action limit is too small. A little over the
  // 25 MB the files may total, for the form's own overhead. uat/tests/sandbox/15-upload-size.spec.ts proves it end to end.
  experimental: { serverActions: { bodySizeLimit: "26mb" } },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
