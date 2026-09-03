import type { KernelIntent } from "./types.ts";
import { extractTrailingJson } from "./waves.ts";
import { instructionHash, truncateMiddle } from "./messages.ts";

const MAX_GOAL_CHARS = 4_000;

const DOMAIN_SIGNALS: Array<{ domain: string; pattern: RegExp }> = [
  { domain: "swe", pattern: /\b(code|function|class|refactor|implement|bug|test|typescript|python|rust|go\b|java|api|endpoint|repo|repository|file|compile|build|deploy|migration|schema|component|library|package|lint|ci\b|pull request|commit)\b/i },
  { domain: "math", pattern: /\b(prove|proof|theorem|lemma|integral|derivative|equation|matrix|probability|combinator|modulo|prime|polynomial|limit|converge|series|\d+\s*[+\-*/^]\s*\d+|solve for|calculate|compute)\b/i },
  { domain: "science", pattern: /\b(experiment|hypothesis|physics|chemistry|biology|molecule|protein|thermodynamic|quantum|entropy|reaction|genome|cell|orbit|velocity|force|energy)\b/i },
  { domain: "research", pattern: /\b(research|survey|literature|compare|comparison|evaluate|assess|investigate|analy[sz]e|summar[iy]|review|pros and cons|trade-?offs?)\b/i },
  { domain: "data", pattern: /\b(dataset|csv|sql|query|pandas|dataframe|statistics|regression|plot|chart|aggregate|etl|pipeline)\b/i },
  { domain: "writing", pattern: /\b(write|draft|essay|article|blog|email|story|poem|rewrite|edit the text|tone|paragraph)\b/i },
  { domain: "ops", pattern: /\b(docker|kubernetes|k8s|terraform|nginx|caddy|server|deploy|infra|ci\/cd|pipeline|monitor|alert|incident|outage)\b/i },
  { domain: "planning", pattern: /\b(plan|roadmap|strategy|architecture|design|approach|milestone|prioriti[sz]e|decide|decision)\b/i },
];

/** Deterministic intent: verbatim goal + regex-derived domains and obvious constraints. */
export function deterministicIntent(goalText: string, sourceMessageIndex: number): KernelIntent {
  const goal = truncateMiddle(goalText.replace(/\s+/g, " ").trim(), MAX_GOAL_CHARS, "goal trimmed");
  const domains = DOMAIN_SIGNALS.filter((d) => d.pattern.test(goal)).map((d) => d.domain);
  const constraints: string[] = [];
  for (const match of goal.matchAll(/\b(must|never|always|do not|don't|only|without|no more than|at most|at least|exactly)\b[^.;\n]{3,120}/gi)) {
    constraints.push(match[0].trim());
    if (constraints.length >= 8) break;
  }
  return {
    goal,
    goalHash: instructionHash(goalText),
    constraints,
    deliverables: [],
    acceptance: [],
    ambiguities: [],
    domains: domains.length > 0 ? domains : ["general"],
    sourceMessageIndex,
    extractedBy: "deterministic",
  };
}

export const INTENT_OBJECTIVE = `Extract the task intent from the recent conversation. Output ONLY a fenced json block:
\`\`\`json
{"goal": "<one-paragraph restatement of what the user actually wants, preserving specifics>", "constraints": ["<hard constraint>"], "deliverables": ["<concrete artifact/answer expected>"], "acceptance": ["<how to tell the task is done correctly>"], "ambiguities": ["<open question the user did not resolve>"], "domains": ["swe"|"math"|"science"|"research"|"data"|"writing"|"ops"|"planning"|"multimodal"|"general"]}
\`\`\`
Keep each list to at most 8 short items. Do not invent requirements the user did not state; put guesses under ambiguities.`;

/** Merge a model-extracted intent JSON over the deterministic base, keeping the verbatim goal hash. */
export function mergeModelIntent(base: KernelIntent, raw: string): KernelIntent {
  const json = extractTrailingJson(raw);
  if (json === undefined) return base;
  const list = (value: unknown, max = 8): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => (typeof item === "string" ? item : JSON.stringify(item)).replace(/\s+/g, " ").trim())
          .filter((item) => item.length > 0)
          .slice(0, max)
      : [];
  const modelGoal = typeof json["goal"] === "string" ? (json["goal"] as string).trim() : "";
  const domains = list(json["domains"], 6).map((d) => d.toLowerCase());
  return {
    ...base,
    // Keep the user's verbatim goal for hashing/continuation; append the model's restatement for workers.
    goal: modelGoal.length > 0 && modelGoal.length <= 2_000 && modelGoal.toLowerCase() !== base.goal.toLowerCase()
      ? `${base.goal}\n(Kernel restatement: ${modelGoal})`
      : base.goal,
    constraints: dedupe([...base.constraints, ...list(json["constraints"])]).slice(0, 10),
    deliverables: list(json["deliverables"]),
    acceptance: list(json["acceptance"]),
    ambiguities: list(json["ambiguities"]),
    domains: domains.length > 0 ? dedupe([...domains, ...base.domains.filter((d) => d !== "general")]).slice(0, 6) : base.domains,
    extractedBy: "model",
  };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
