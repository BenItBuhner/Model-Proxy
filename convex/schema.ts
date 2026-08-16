import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  providerAccounts: defineTable({
    accountId: v.string(),
    provider: v.string(),
    kind: v.string(),
    label: v.string(),
    email: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    plan: v.optional(v.string()),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.optional(v.string()),
    idTokenCiphertext: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    shared: v.boolean(),
    status: v.string(),
    lastError: v.optional(v.string()),
    lastUsedAt: v.optional(v.string()),
    lastRefreshedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    metadataJson: v.string(),
    sourceInstance: v.string(),
  })
    .index("by_account_id", ["accountId"])
    .index("by_provider_status", ["provider", "status"])
    .index("by_owner", ["ownerUserId"]),
  accountMirrorRevisions: defineTable({
    sourceInstance: v.string(),
    revision: v.string(),
    accountCount: v.number(),
    syncedAt: v.string(),
  }).index("by_source", ["sourceInstance"]),
});
