import { z } from "zod";

const NonNegativeMoneySchema = z.number().finite().nonnegative();

export const TokenPricingSchema = z
  .object({
    input_per_1m: NonNegativeMoneySchema.default(0),
    output_per_1m: NonNegativeMoneySchema.default(0),
    cache_read_per_1m: NonNegativeMoneySchema.optional(),
    cache_creation_per_1m: NonNegativeMoneySchema.optional(),
  })
  .passthrough();

export const PricingConfigSchema = z
  .object({
    user_cost: TokenPricingSchema.default({}),
    typical_cost: TokenPricingSchema.default({}),
  })
  .passthrough();

export type TokenPricing = z.infer<typeof TokenPricingSchema>;
export type PricingConfig = z.infer<typeof PricingConfigSchema>;
