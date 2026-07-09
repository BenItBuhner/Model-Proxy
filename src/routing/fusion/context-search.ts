/**
 * Keyword-match search across conversation messages, returning the most
 * relevant excerpts. Used by the task divider to inspect the already-supplied
 * conversation without exposing tools to subagents.
 */
export function searchConversationContext(messages: unknown[], query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return "No query terms provided.";

  const scored: Array<{ index: number; role: string; text: string; score: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const obj = messages[i] as Record<string, unknown>;
    const text = typeof obj?.["content"] === "string"
      ? (obj["content"] as string)
      : JSON.stringify(obj?.["content"] ?? "");
    const lower = text.toLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
    if (score > 0) {
      scored.push({ index: i, role: String(obj?.["role"] ?? "unknown"), text, score });
    }
  }

  if (scored.length === 0) return `No conversation messages matched "${query}".`;

  scored.sort((a, b) => b.score - a.score);
  const excerpts = scored.slice(0, 5).map((hit) => {
    const firstTerm = terms.find((t) => hit.text.toLowerCase().includes(t)) ?? terms[0];
    const at = Math.max(0, hit.text.toLowerCase().indexOf(firstTerm) - 150);
    const excerpt = hit.text.slice(at, at + 450);
    return `[message ${hit.index + 1}, role=${hit.role}, matched ${hit.score}/${terms.length} terms]\n...${excerpt}...`;
  });
  return excerpts.join("\n\n");
}
