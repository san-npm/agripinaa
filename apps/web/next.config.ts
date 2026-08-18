import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: [
    "@agripinaa/agent-index",
    "@agripinaa/shared",
    "@agripinaa/exec-metrics",
    "@agripinaa/session-kit",
  ],
};

export default nextConfig;
