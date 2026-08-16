import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

const account = v.object({
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
});

/**
 * Reconciles one Model-Proxy instance's encrypted account snapshot.
 * Credential values are already AES-256-GCM ciphertext before leaving the
 * proxy. CONVEX_SYNC_SECRET prevents arbitrary public mutation calls.
 */
export const reconcile = mutationGeneric({
  args: {
    syncSecret: v.string(),
    sourceInstance: v.string(),
    revision: v.string(),
    accounts: v.array(account),
  },
  returns: v.object({ upserted: v.number(), removed: v.number() }),
  handler: async (ctx, args) => {
    const expected = process.env["CONVEX_SYNC_SECRET"];
    if (expected === undefined || expected.length < 24 || args.syncSecret !== expected) {
      throw new Error("Unauthorized account mirror");
    }
    const incoming = new Set(args.accounts.map((entry) => entry.accountId));
    const existing = await ctx.db.query("providerAccounts").collect();
    let removed = 0;
    for (const row of existing) {
      if (row.sourceInstance === args.sourceInstance && !incoming.has(row.accountId)) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    for (const entry of args.accounts) {
      const row = await ctx.db
        .query("providerAccounts")
        .withIndex("by_account_id", (q) => q.eq("accountId", entry.accountId))
        .unique();
      const value = { ...entry, sourceInstance: args.sourceInstance };
      if (row === null) await ctx.db.insert("providerAccounts", value);
      else await ctx.db.patch(row._id, value);
    }
    const revision = await ctx.db
      .query("accountMirrorRevisions")
      .withIndex("by_source", (q) => q.eq("sourceInstance", args.sourceInstance))
      .unique();
    const revisionValue = {
      sourceInstance: args.sourceInstance,
      revision: args.revision,
      accountCount: args.accounts.length,
      syncedAt: new Date().toISOString(),
    };
    if (revision === null) await ctx.db.insert("accountMirrorRevisions", revisionValue);
    else await ctx.db.patch(revision._id, revisionValue);
    return { upserted: args.accounts.length, removed };
  },
});
