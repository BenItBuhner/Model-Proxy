interface SearchHit {
  index: number;
  role: string;
  text: string;
  score: number;
  matchedTerms: number;
  occurrences: number;
}

const MAX_SEARCH_EXCERPTS = 12;
const EXCERPT_CHARS = 700;

/**
 * Keyword-match search across conversation messages, returning stratified
 * excerpts plus coverage metadata. Used by the task divider to inspect the
 * already-supplied conversation without exposing tools to subagents.
 */
export function searchConversationContext(messages: unknown[], query: string): string {
  const terms = uniqueTerms(query);
  if (terms.length === 0) return "No query terms provided.";

  const scored: SearchHit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const obj = messages[i] as Record<string, unknown>;
    const text = messageText(obj);
    const lower = text.toLowerCase();
    let matchedTerms = 0;
    let occurrences = 0;
    for (const term of terms) {
      const count = countOccurrences(lower, term);
      if (count > 0) {
        matchedTerms++;
        occurrences += count;
      }
    }
    if (matchedTerms > 0) {
      const recencyBoost = messages.length > 0 ? i / messages.length : 0;
      scored.push({
        index: i,
        role: String(obj?.["role"] ?? "unknown"),
        text,
        score: matchedTerms * 100 + occurrences * 5 + recencyBoost,
        matchedTerms,
        occurrences,
      });
    }
  }

  if (scored.length === 0) {
    return [
      `No conversation messages matched "${query}".`,
      `Searched ${messages.length} messages for terms: ${terms.join(", ")}.`,
      "Use a broader query or ask for a different focus area if the divider still needs context.",
    ].join("\n");
  }

  const selected = selectSearchHits(scored);
  const roleCounts = new Map<string, number>();
  for (const hit of scored) roleCounts.set(hit.role, (roleCounts.get(hit.role) ?? 0) + 1);
  const roleSummary = [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, count]) => `${role}=${count}`)
    .join(", ");

  const header = [
    `Search context results for "${query}"`,
    `Coverage: ${scored.length}/${messages.length} messages matched ${terms.length} query term(s).`,
    `Matched roles: ${roleSummary || "none"}.`,
    `Returning ${selected.length} stratified excerpt(s): strongest matches first, then recency-preserving coverage where useful.`,
  ];

  const excerpts = selected.map((hit) => {
    const excerpt = excerptAroundTerms(hit.text, terms, EXCERPT_CHARS);
    return [
      `[message ${hit.index + 1}/${messages.length}, role=${hit.role}, matched ${hit.matchedTerms}/${terms.length} terms, occurrences=${hit.occurrences}]`,
      excerpt,
    ].join("\n");
  });

  return [...header, "", ...excerpts].join("\n\n");
}

function uniqueTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of query.toLowerCase().split(/\W+/)) {
    if (term.length <= 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function messageText(message: Record<string, unknown>): string {
  const content = message?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const obj = part as Record<string, unknown>;
      if (typeof obj?.["text"] === "string") return obj["text"];
      if (typeof obj?.["content"] === "string") return obj["content"];
      if (typeof obj?.["type"] === "string") return `[${obj["type"]}]`;
      return JSON.stringify(part ?? "");
    }).join("\n");
  }
  return JSON.stringify(content ?? "");
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let at = text.indexOf(term);
  while (at !== -1) {
    count++;
    at = text.indexOf(term, at + term.length);
  }
  return count;
}

function selectSearchHits(scored: SearchHit[]): SearchHit[] {
  const selected = new Map<number, SearchHit>();
  const add = (hit: SearchHit | undefined) => {
    if (hit !== undefined) selected.set(hit.index, hit);
  };

  const strongest = [...scored].sort((a, b) => b.score - a.score || b.index - a.index);
  for (const hit of strongest.slice(0, 8)) add(hit);

  const recent = [...scored].sort((a, b) => b.index - a.index);
  for (const hit of recent.slice(0, 3)) add(hit);

  const chronological = [...scored].sort((a, b) => a.index - b.index);
  if (chronological.length > 2) {
    add(chronological[0]);
    add(chronological[Math.floor(chronological.length / 2)]);
    add(chronological[chronological.length - 1]);
  }

  return [...selected.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SEARCH_EXCERPTS);
}

function excerptAroundTerms(text: string, terms: string[], maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const firstAt = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstAt - Math.floor(maxChars * 0.35));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
