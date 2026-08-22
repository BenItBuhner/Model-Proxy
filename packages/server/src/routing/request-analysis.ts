import { estimateRequestTokens } from "../server/request-log.ts";

export interface RoutingRequestAnalysis {
  hasMultimodalContent: boolean;
  estimatedPromptTokens: number | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageLikeBlock(value: Record<string, unknown>): boolean {
  const type = value["type"];
  if (type === "image" || type === "image_url" || type === "input_image") {
    return true;
  }
  return "image_url" in value;
}

function contentHasMultimodalBlock(content: unknown): boolean {
  if (Array.isArray(content)) {
    return content.some((item) => contentHasMultimodalBlock(item));
  }
  if (!isObject(content)) return false;
  if (isImageLikeBlock(content)) return true;
  const nestedContent = content["content"];
  if (nestedContent !== undefined && contentHasMultimodalBlock(nestedContent)) {
    return true;
  }
  return false;
}

export function hasMultimodalContent(requestData: Record<string, unknown>): boolean {
  const messages = requestData["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isObject(message)) continue;
      if (contentHasMultimodalBlock(message["content"])) return true;
    }
  }
  return contentHasMultimodalBlock(requestData["system"]);
}

export function analyzeRequestForRouting(
  requestData: Record<string, unknown>,
): RoutingRequestAnalysis {
  return {
    hasMultimodalContent: hasMultimodalContent(requestData),
    estimatedPromptTokens: estimateRequestTokens(requestData),
  };
}
