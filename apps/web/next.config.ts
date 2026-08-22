import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@model-proxy/contracts"],
  // Admin panel is served at /setup/* by the Bun proxy.
  basePath: process.env.NODE_ENV === "production" ? "/setup" : "",
  assetPrefix: process.env.NODE_ENV === "production" ? "/setup" : undefined,
};

export default config;
