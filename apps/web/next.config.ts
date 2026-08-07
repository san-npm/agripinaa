import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: ["@foyer/agent-index", "@foyer/shared"],
};

export default nextConfig;
