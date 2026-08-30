import type { Context } from "hono";

/** Read a JSON object body, returning {} for missing/invalid/non-object bodies. */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = (await c.req.json()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
