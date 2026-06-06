import type { Context } from "hono";

/** Build x-opencode-* and session headers forwarded to upstream providers. */
export function buildUpstreamExtraHeaders(
  c: Context,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const session =
    c.req.header("x-opencode-session") ??
    c.req.header("x-session-affinity") ??
    requestId;
  headers["x-opencode-session"] = session;
  headers["x-opencode-request"] = c.req.header("x-opencode-request") ?? requestId;
  headers["x-opencode-client"] = c.req.header("x-opencode-client") ?? "model-proxy";
  const project = c.req.header("x-opencode-project");
  if (project !== undefined && project.length > 0) {
    headers["x-opencode-project"] = project;
  }
  const userAgent = c.req.header("user-agent");
  if (userAgent !== undefined && userAgent.length > 0) {
    headers["User-Agent"] = userAgent;
  }
  return headers;
}
