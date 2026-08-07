import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: ["@agripinaa/agent-index", "@agripinaa/shared"],
};

export default nextConfig;
