import { describe, expect, it } from "bun:test";
import { resolveFusionIdentity } from "../src/storage/fusion-store.ts";

const SYSTEM = { role: "system", content: "You are an expert software engineer fixing a GitHub issue." };

describe("fusion conversation identity", () => {
  it("separates conversations that share a system prompt but open with different user messages", () => {
    const a = resolveFusionIdentity({ requestId: "r1", logicalModel: "fusion-max", messages: [SYSTEM, { role: "user", content: "Fix issue #1" }] });
    const b = resolveFusionIdentity({ requestId: "r2", logicalModel: "fusion-max", messages: [SYSTEM, { role: "user", content: "Fix issue #2" }] });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  it("keeps later turns of the same conversation on the same id", () => {
    const first = [SYSTEM, { role: "user", content: "Fix issue #1" }];
    const a = resolveFusionIdentity({ requestId: "r1", logicalModel: "fusion-max", messages: first });
    const b = resolveFusionIdentity({ requestId: "r2", logicalModel: "fusion-max", messages: [...first, { role: "assistant", content: null, tool_calls: [] }, { role: "tool", tool_call_id: "c1", content: "ok" }] });
    expect(a.conversationId).toBe(b.conversationId);
    expect(a.turnId).not.toBe(b.turnId);
  });

  it("prefers an explicit session header over message-derived identity", () => {
    const a = resolveFusionIdentity({ requestId: "r1", logicalModel: "fusion-max", messages: [SYSTEM, { role: "user", content: "A" }], extraHeaders: { "x-session-affinity": "s-1" } });
    const b = resolveFusionIdentity({ requestId: "r2", logicalModel: "fusion-max", messages: [SYSTEM, { role: "user", content: "B" }], extraHeaders: { "x-session-affinity": "s-1" } });
    expect(a.conversationId).toBe(b.conversationId);
  });
});
