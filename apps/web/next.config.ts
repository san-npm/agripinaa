import type { NextConfig } from "next";
import { resolve } from "node:path";
import workspace from "../../package.json";

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: [
    "@agripinaa/agent-index",
    "@agripinaa/shared",
    "@agripinaa/exec-metrics",
    "@agripinaa/session-kit",
  ],
  webpack(config) {
    if (config.cache && typeof config.cache === "object") {
      // Patched dependencies keep their package versions. Track the patches
      // explicitly so restored caches cannot serve pre-patch wallet code.
      config.cache.buildDependencies ??= {};
      config.cache.buildDependencies.patches = Object.values(workspace.pnpm.patchedDependencies)
        .map((path) => resolve(__dirname, "../..", path));
    }
    return config;
  },
};

export default nextConfig;
