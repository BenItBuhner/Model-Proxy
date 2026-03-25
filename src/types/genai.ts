/**
 * Google GenAI / Gemini API type definitions (Zod schemas).
 */
import { z } from "zod";

// ── Parts ─────────────────────────────────────────────────────────
export const TextPartSchema = z.object({
  text: z.string(),
});

export const FunctionCallPartSchema = z.object({
  functionCall: z.object({
    name: z.string(),
    args: z.record(z.any()).optional(),
  }),
});

export const FunctionResponsePartSchema = z.object({
  functionResponse: z.object({
    name: z.string(),
    response: z.record(z.any()),
  }),
});

export const PartSchema = z.union([
  TextPartSchema,
  FunctionCallPartSchema,
  FunctionResponsePartSchema,
  z.record(z.any()),
]);

// ── Content ───────────────────────────────────────────────────────
export const ContentSchema = z.object({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(PartSchema),
});

// ── Tool Definitions ──────────────────────────────────────────────
export const FunctionDeclarationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.any()).optional(),
});

export const GenaiToolSchema = z.object({
  functionDeclarations: z.array(FunctionDeclarationSchema).optional(),
});

// ── Generation Config ─────────────────────────────────────────────
export const GenerationConfigSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  candidateCount: z.number().optional(),
  responseMimeType: z.string().optional(),
});

// ── Safety Settings ───────────────────────────────────────────────
export const SafetySettingSchema = z.object({
  category: z.string(),
  threshold: z.string(),
});

// ── Request ───────────────────────────────────────────────────────
export const GenerateContentRequestSchema = z.object({
  model: z.string().optional(),
  contents: z.union([z.string(), z.array(ContentSchema)]),
  systemInstruction: z.union([z.string(), ContentSchema]).optional(),
  generationConfig: GenerationConfigSchema.optional(),
  tools: z.array(GenaiToolSchema).optional(),
  safetySettings: z.array(SafetySettingSchema).optional(),
  toolConfig: z.record(z.any()).optional(),
});

// ── Response ──────────────────────────────────────────────────────
export const GenaiUsageMetadataSchema = z.object({
  promptTokenCount: z.number().default(0),
  candidatesTokenCount: z.number().default(0),
  totalTokenCount: z.number().default(0),
});

export const CandidateSchema = z.object({
  content: ContentSchema.optional(),
  finishReason: z.string().optional(),
  index: z.number().optional(),
  safetyRatings: z.array(z.any()).optional(),
});

export const GenerateContentResponseSchema = z.object({
  candidates: z.array(CandidateSchema).optional(),
  usageMetadata: GenaiUsageMetadataSchema.optional(),
  modelVersion: z.string().optional(),
});

// ── Inferred Types ────────────────────────────────────────────────
export type Part = z.infer<typeof PartSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type GenerationConfig = z.infer<typeof GenerationConfigSchema>;
export type GenerateContentRequest = z.infer<typeof GenerateContentRequestSchema>;
export type GenerateContentResponse = z.infer<typeof GenerateContentResponseSchema>;
export type GenaiUsageMetadata = z.infer<typeof GenaiUsageMetadataSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
