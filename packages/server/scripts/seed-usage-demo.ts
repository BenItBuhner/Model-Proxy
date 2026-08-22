import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".storage", "metrics");
rmSync(join(process.cwd(), ".storage"), { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const providers = [
  { provider: "openai", model: "gpt-4o-mini", key: "OPENAI_API_KEY", userRate: 0.15, typicalRate: 2.5 },
  { provider: "groq", model: "llama-3.3-70b", key: "GROQ_API_KEY", userRate: 0.05, typicalRate: 1.8 },
  { provider: "cerebras", model: "zai-glm-4.7", key: "CEREBRAS_API_KEY", userRate: 0.02, typicalRate: 1.2 },
] as const;

const now = Date.now();
const byDay = new Map<string, Array<Record<string, unknown>>>();

function push(day: string, row: Record<string, unknown>): void {
  const rows = byDay.get(day) ?? [];
  rows.push(row);
  byDay.set(day, rows);
}

let id = 0;
for (let hoursBack = 96; hoursBack >= 0; hoursBack -= 1) {
  const bucketStart = new Date(now - hoursBack * 60 * 60 * 1000);
  const requestsThisHour = hoursBack < 24 ? 3 + (hoursBack % 4) : 1 + (hoursBack % 3);
  for (let i = 0; i < requestsThisHour; i++) {
    const route = providers[(hoursBack + i) % providers.length]!;
    const prompt = 400 + ((hoursBack * 17 + i * 31) % 2200);
    const completion = 120 + ((hoursBack * 11 + i * 19) % 900);
    const total = prompt + completion;
    const cacheHit = (hoursBack + i) % 5 === 0;
    const matched = cacheHit ? Math.floor(prompt * 0.6) : 0;
    const userCost = (prompt / 1e6) * route.userRate + (completion / 1e6) * route.userRate * 3;
    const typicalCost = (prompt / 1e6) * route.typicalRate + (completion / 1e6) * route.typicalRate * 4;
    const ts = new Date(bucketStart.getTime() + i * 7 * 60 * 1000 + ((hoursBack * 13) % 50) * 1000);
    const day = ts.toISOString().slice(0, 10);
    push(day, {
      version: 1,
      requestId: `demo-${String(++id).padStart(4, "0")}`,
      timestamp: ts.toISOString(),
      completedAt: new Date(ts.getTime() + 800 + (i % 5) * 200).toISOString(),
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedProvider: route.provider,
      resolvedModel: route.model,
      wireProtocol: "openai",
      apiKeyEnvVar: route.key,
      keyHint: "...demo",
      principalRole: "owner",
      ownerBypass: true,
      responseStatus: 200,
      state: "completed",
      elapsedMs: 800 + (i % 5) * 200,
      responseTimeMs: 800 + (i % 5) * 200,
      isStreaming: i % 2 === 0,
      enforceMode: false,
      retryCount: 0,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      cacheReadTokens: matched,
      cacheCreationTokens: 0,
      cachedTokens: matched,
      matchedTokens: matched,
      isCacheHit: cacheHit,
      userCostUsd: Math.round(userCost * 1e6) / 1e6,
      typicalCostUsd: Math.round(typicalCost * 1e6) / 1e6,
      savedCostUsd: Math.round(Math.max(0, typicalCost - userCost) * 1e6) / 1e6,
    });
  }
}

for (const [day, rows] of byDay) {
  writeFileSync(join(root, `requests-${day}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

console.log(`Seeded ${id} demo requests across ${byDay.size} days into .storage/metrics`);
