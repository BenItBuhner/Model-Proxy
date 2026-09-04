import { createHash } from "node:crypto";
import type { ModelRoutingConfig } from "@model-proxy/contracts/schemas/routing.ts";
import { modelConfigLoader } from "../config/model-loader.ts";
import { createLogger } from "../observability/logger.ts";
import { canUseLogicalModel } from "../policy/access-control.ts";
import type { Principal } from "../storage/identity-store.ts";
import { isObject } from "../shared/utils.ts";
const log = createLogger("routing.image-describer");
const DESCRIPTION_SYSTEM_PROMPT =
  "You are a precise image analyst. Describe images in thorough, objective detail. Focus on factual visual elements and avoid subjective interpretation unless asked.";
const DESCRIPTION_PROMPT = `Describe this image in comprehensive detail. Include:
- The overall scene/subject
- Key objects, people, text, or elements visible
- Colors, composition, spatial relationships
- Any text or labels present
- The mood, style, or context

Be thorough and specific - this description will be used by another AI model that cannot see the image directly.`;
const MAX_CACHE_ENTRIES = 256;
export const IMAGE_DESCRIPTION_MODEL_ENV = "MODEL_PROXY_IMAGE_DESCRIPTION_MODEL";
const cache = new Map<string, string>();
export function clearImageDescriptionCache(): void {
  cache.clear();
}
function cacheGet(key: string): string | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}
function cacheSet(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, value);
}
/**
 * Pick the logical model used to describe images: MODEL_PROXY_IMAGE_DESCRIPTION_MODEL
 * when set (strict - unusable values disable the fallback), otherwise the first
 * available non-fusion model that declares a multimodal-capable route.
 */
export function resolveVisionModel(
  principal: Principal | undefined,
  excludeModels: ReadonlySet<string> = new Set(),
): string | undefined {
  const envModel = process.env[IMAGE_DESCRIPTION_MODEL_ENV]?.trim();
  if (envModel !== undefined && envModel.length > 0) {
    if (excludeModels.has(envModel) || !canUseLogicalModel(principal, envModel)) return undefined;
    try {
      modelConfigLoader.loadConfig(envModel);
    } catch (err) {
      log.warn("configured image description model is unavailable", { model: envModel, error: String(err) });
      return undefined;
    }
    return envModel;
  }
  for (const name of modelConfigLoader.getAvailableModels()) {
    if (excludeModels.has(name) || !canUseLogicalModel(principal, name)) continue;
    let config: ModelRoutingConfig;
    try {
      config = modelConfigLoader.loadConfig(name);
    } catch {
      continue;
    }
    if (config.fusion !== undefined) continue;
    if (config.model_routings.some((route) => route.capabilities?.multimodal === true)) return name;
  }
  return undefined;
}
interface ImageSource {
  source: string;
  detail: string | undefined;
}
interface ImageOccurrence extends ImageSource {
  container: unknown[];
  index: number;
}
interface ImageTarget {
  context: string;
  occurrences: ImageOccurrence[];
}
function openAiImageSource(part: Record<string, unknown>): ImageSource | undefined {
  const imageUrl = part["image_url"];
  if (typeof imageUrl === "string") return { source: imageUrl, detail: undefined };
  if (isObject(imageUrl) && typeof imageUrl["url"] === "string") {
    const detail = typeof imageUrl["detail"] === "string" ? imageUrl["detail"] : undefined;
    return { source: imageUrl["url"], detail };
  }
  return undefined;
}
function responsesInputImageSource(part: Record<string, unknown>): ImageSource | undefined {
  const imageUrl = part["image_url"] ?? part["url"];
  if (typeof imageUrl === "string") return { source: imageUrl, detail: undefined };
  if (isObject(imageUrl) && typeof imageUrl["url"] === "string") {
    return { source: imageUrl["url"], detail: undefined };
  }
  return undefined;
}
function anthropicImageSource(part: Record<string, unknown>): ImageSource | undefined {
  const source = part["source"];
  if (!isObject(source)) return undefined;
  if (source["type"] === "url" && typeof source["url"] === "string") {
    return { source: source["url"], detail: undefined };
  }
  if (source["type"] === "base64" && typeof source["data"] === "string") {
    const mediaType = typeof source["media_type"] === "string" ? source["media_type"] : "image/png";
    return { source: `data:${mediaType};base64,${source["data"]}`, detail: undefined };
  }
  return undefined;
}
function imageSourceOf(value: unknown): ImageSource | undefined {
  if (!isObject(value)) return undefined;
  const type = value["type"];
  if (type === "image_url" || (type !== "image" && type !== "input_image" && "image_url" in value)) {
    return openAiImageSource(value);
  }
  if (type === "input_image") return responsesInputImageSource(value);
  if (type === "image") return anthropicImageSource(value);
  return undefined;
}
function collectOccurrences(content: unknown[], out: ImageOccurrence[]): void {
  content.forEach((part, index) => {
    const source = imageSourceOf(part);
    if (source !== undefined) {
      out.push({ ...source, container: content, index });
      return;
    }
    if (isObject(part) && Array.isArray(part["content"])) {
      collectOccurrences(part["content"] as unknown[], out);
    }
  });
}
function messageTextContext(content: unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (isObject(part) && part["type"] === "text" && typeof part["text"] === "string") {
      parts.push(part["text"]);
    }
  }
  return parts.join("\n");
}
function collectTargets(requestData: Record<string, unknown>): ImageTarget[] {
  const targets: ImageTarget[] = [];
  const pushContent = (content: unknown[]): void => {
    const occurrences: ImageOccurrence[] = [];
    collectOccurrences(content, occurrences);
    if (occurrences.length > 0) targets.push({ context: messageTextContext(content), occurrences });
  };
  const messages = requestData["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isObject(message)) continue;
      if (Array.isArray(message["content"])) pushContent(message["content"]);
    }
  }
  if (Array.isArray(requestData["system"])) pushContent(requestData["system"]);
  return targets;
}
function extractResponseText(response: Record<string, unknown>): string {
  const choices = response["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown> | undefined)?.["message"];
    if (isObject(message) && typeof message["content"] === "string") return message["content"];
  }
  const content = response["content"];
  if (Array.isArray(content)) {
    return content
      .filter((block) => isObject(block) && block["type"] === "text")
      .map((block) => String((block as Record<string, unknown>)["text"] ?? ""))
      .join("\n");
  }
  return JSON.stringify(response);
}
export interface DescribeRequestImagesOptions {
  requestData: Record<string, unknown>;
  visionModel: string;
  callModel: (requestData: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
export interface DescribeRequestImagesResult {
  requestData: Record<string, unknown>;
  imageCount: number;
  cacheHits: number;
  descriptions: string[];
}
async function describeImage(
  source: string,
  context: string,
  options: DescribeRequestImagesOptions,
): Promise<{ text: string; cacheable: boolean }> {
  const prompt = context.trim().length > 0
    ? `Context from the conversation:\n${context}\n\n${DESCRIPTION_PROMPT}`
    : DESCRIPTION_PROMPT;
  const visionRequest: Record<string, unknown> = {
    model: options.visionModel,
    messages: [
      { role: "system", content: DESCRIPTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: source, detail: "high" } },
        ],
      },
    ],
    max_tokens: 4096,
  };
  try {
    const response = await options.callModel(visionRequest);
    const text = extractResponseText(response);
    if (text.trim().length === 0) throw new Error("empty description");
    return { text, cacheable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("image description call failed", { model: options.visionModel, error: message });
    // Keep the placeholder generic: provider error bodies can carry URLs, key
    // hints, or internal model names that must not leak into the conversation.
    return { text: "[Image description unavailable - the vision model call failed]", cacheable: false };
  }
}
function wrapDescription(detail: string | undefined, description: string): string {
  const note = detail !== undefined && detail !== "auto" ? ` (detail: ${detail})` : "";
  return `[Image${note} description: ${description}]`;
}
/**
 * Replace every image in the request with a text description produced by the
 * vision model. Descriptions are cached by image content so repeated images
 * (e.g. multi-turn history) cost one vision call. Returns a cloned request
 * with image parts swapped for text parts, or undefined when no image found.
 */
export async function describeRequestImages(
  options: DescribeRequestImagesOptions,
): Promise<DescribeRequestImagesResult | undefined> {
  const clone = JSON.parse(JSON.stringify(options.requestData)) as Record<string, unknown>;
  const targets = collectTargets(clone);
  if (targets.length === 0) return undefined;
  const imageCount = targets.reduce((sum, target) => sum + target.occurrences.length, 0);
  let cacheHits = 0;
  const descriptions: string[] = [];
  for (const target of targets) {
    for (const occurrence of target.occurrences) {
      const key = createHash("sha256").update(occurrence.source).digest("hex");
      const cached = cacheGet(key);
      let text: string;
      if (cached !== undefined) {
        text = cached;
        cacheHits += 1;
      } else {
        const described = await describeImage(occurrence.source, target.context, options);
        text = described.text;
        if (described.cacheable) cacheSet(key, described.text);
      }
      descriptions.push(text);
      occurrence.container[occurrence.index] = { type: "text", text: wrapDescription(occurrence.detail, text) };
    }
  }
  log.info("replaced request images with descriptions", {
    visionModel: options.visionModel,
    imageCount,
    cacheHits,
  });
  return { requestData: clone, imageCount, cacheHits, descriptions };
}
