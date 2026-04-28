import {
  providerConfigLoader,
} from "../config/provider-loader.ts";
import type { ProviderConfig } from "../../shared/schemas/provider.ts";

function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? `\${${varName}}`;
  });
}

export function buildEndpointUrl(
  config: ProviderConfig,
  override?: string,
  endpointType:
    | "completions"
    | "streaming"
    | "audio_transcriptions"
    | "audio_translations"
    | "audio_streaming" = "completions",
): string {
  let base = override ?? config.endpoints.base_url;
  if (config.proxy_support?.enabled === true) {
    const overrideUrl = config.proxy_support.base_url_override;
    if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
      base = overrideUrl;
    }
  }
  base = substituteEnvVars(base);

  const rawPath =
    endpointType === "streaming"
      ? config.endpoints.streaming ?? config.endpoints.completions
      : endpointType === "audio_transcriptions"
        ? config.endpoints.audio_transcriptions ?? "/audio/transcriptions"
        : endpointType === "audio_translations"
          ? config.endpoints.audio_translations ?? "/audio/translations"
          : endpointType === "audio_streaming"
            ? config.endpoints.audio_streaming ??
              config.endpoints.audio_transcriptions ??
              "/audio/transcriptions"
            : config.endpoints.completions;
  const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;

  return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

export function buildAuthHeaders(
  config: ProviderConfig,
  apiKey: string,
): Record<string, string> {
  const auth = config.authentication;
  const headers: Record<string, string> = {};

  if (auth.type === "none") return headers;

  const headerName = auth.header_name;
  if (typeof headerName !== "string" || headerName.length === 0) {
    throw new Error(
      `Provider '${config.name}' has auth.type=${auth.type} but no header_name`,
    );
  }

  const format = auth.header_format ?? "{api_key}";
  headers[headerName] = format.replaceAll("{api_key}", apiKey);

  if (auth.additional_headers !== undefined) {
    for (const [key, value] of Object.entries(auth.additional_headers)) {
      headers[key] = substituteEnvVars(String(value));
    }
  }

  return headers;
}

export function getProviderWireProtocol(
  providerName: string,
): "openai" | "anthropic" {
  try {
    const config = providerConfigLoader.loadProvider(providerName);
    const fmt = config.endpoints.compatible_format?.toLowerCase();
    if (fmt === "anthropic") return "anthropic";
    return "openai";
  } catch {
    return "openai";
  }
}
