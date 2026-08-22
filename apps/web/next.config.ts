import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@model-proxy/contracts"],
  // The admin UI is served at the proxy root; no basePath needed.
};

export default config;
