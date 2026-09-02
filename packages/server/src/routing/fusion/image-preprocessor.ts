import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import { describeRequestImages, resolveVisionModel } from "../image-describer.ts";
import type { FusionRequestContext } from "./types.ts";
const log = createLogger("routing.fusion.image-preprocessor");
export class ImagePreprocessor {
  private readonly fallbackRouter: FallbackRouter;
  static readonly IMAGE_DESCRIPTION_MODEL = "kimi-k2.7-code";
  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }
  async process(ctx: FusionRequestContext): Promise<void> {
    const visionModel = resolveVisionModel(ctx.principal) ?? ImagePreprocessor.IMAGE_DESCRIPTION_MODEL;
    const result = await describeRequestImages({
      requestData: { messages: ctx.messages },
      visionModel,
      callModel: async (requestData) =>
        await this.fallbackRouter.callWithFallback({
          logicalModel: visionModel,
          requestData,
          targetProtocol: "openai",
          signal: ctx.signal,
          principal: ctx.principal,
          validateResponse: false,
          skipImageDescription: true,
        }),
    });
    if (result === undefined) {
      ctx.hadImages = false;
      return;
    }
    const messages = result.requestData["messages"];
    if (Array.isArray(messages)) {
      ctx.messages = messages;
      ctx.requestData = { ...ctx.requestData, messages };
    }
    ctx.hadImages = true;
    ctx.imageDescriptions = result.descriptions;
    log.info("image preprocessing complete", {
      visionModel,
      totalImages: result.imageCount,
      cacheHits: result.cacheHits,
    });
  }
}
