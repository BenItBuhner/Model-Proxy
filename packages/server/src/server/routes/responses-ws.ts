import type { ServerWebSocket } from "bun";
import { OpenAIResponsesRequest } from "@model-proxy/contracts/schemas/openai-wire.ts";
import type { Principal } from "../../storage/identity-store.ts";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  modelConfigLoader,
} from "../../config/model-loader.ts";
import {
  extractResponsesOutputText,
  responsesInputItemsForStorage,
  responsesRequestToChat,
} from "../../format/responses.ts";
import {
  getGlobalResponseStore,
  previousResponseNotFoundError,
} from "../../format/response-store.ts";
import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../../routing/fallback.ts";
import {
  AccessDeniedError,
  assertCanUseLogicalModel,
} from "../../policy/access-control.ts";
import { isAuthConfigured, verifyApiKeyString } from "../auth.ts";
import {
  authenticateApiKey,
  legacyOwnerPrincipal,
  noAuthPrincipal,
} from "../../storage/identity-store.ts";
import {
  estimateRequestTokens,
  recordRequestFinish,
  recordRequestStart,
} from "../request-log.ts";
import {
  emit,
  nowIso,
  runWithRequestContext,
} from "../../observability/request-context.ts";

export type WsData = { request: Request; principal?: Principal };

const log = createLogger("routes.responses-ws");
const WS_TIMEOUT_MS = 60 * 60 * 1000;

function ownerId(principal: Principal | undefined): string | undefined {
  return principal?.userId ?? principal?.id;
}

interface WsConnectionState {
  inflight: boolean;
  previousResponseId: string | undefined;
  previousMessages: Array<Record<string, unknown>> | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  principal: Principal | undefined;
  requestIdCounter: number;
}

const connections = new WeakMap<ServerWebSocket<WsData>, WsConnectionState>();

function getState(ws: ServerWebSocket<WsData>): WsConnectionState {
  let state = connections.get(ws);
  if (state === undefined) {
    state = {
      inflight: false,
      previousResponseId: undefined,
      previousMessages: undefined,
      timeout: undefined,
      principal: undefined,
      requestIdCounter: 0,
    };
    connections.set(ws, state);
  }
  return state;
}

function resetTimeout(ws: ServerWebSocket<WsData>): void {
  const state = getState(ws);
  if (state.timeout !== undefined) clearTimeout(state.timeout);
  state.timeout = setTimeout(() => {
    try {
      ws.send(JSON.stringify({ type: "error", error: { message: "Connection timeout after 60 minutes" } }));
      ws.close(4001, "Connection timeout");
    } catch {
      // already closed
    }
  }, WS_TIMEOUT_MS);
}

export function isResponsesWsPath(path: string): boolean {
  return path === "/v1/responses";
}

export async function responsesWsAuth(req: Request): Promise<Principal | undefined> {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  let presented: string | undefined;
  if (authHeader !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1] !== undefined && match[1].length > 0) {
      presented = match[1].trim();
    }
  }

  const headerKey = req.headers.get("x-api-key") ?? req.headers.get("X-API-Key");
  if (presented === undefined && headerKey !== null && headerKey.trim().length > 0) {
    presented = headerKey.trim();
  }

  if (presented === undefined) {
    const queryKey = new URL(req.url).searchParams.get("api_key");
    if (queryKey !== null && queryKey.length > 0) presented = queryKey.trim();
  }

  if (!isAuthConfigured()) return noAuthPrincipal();
  const userPrincipal = authenticateApiKey(presented);
  if (userPrincipal !== undefined) return userPrincipal;
  if (presented !== undefined && verifyApiKeyString(presented)) {
    return legacyOwnerPrincipal();
  }

  return undefined;
}

export function onWsOpen(ws: ServerWebSocket<WsData>): void {
  const state = getState(ws);
  const data = ws.data;
  const req = data.request;
  state.principal = data.principal;
  resetTimeout(ws);
  log.info("responses WS connected", {
    remoteAddress: req.headers.get("x-forwarded-for") ?? "unknown",
  });
}

export function onWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  resetTimeout(ws);
  const state = getState(ws);

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
  } catch {
    ws.send(JSON.stringify({ type: "error", error: { message: "Invalid JSON" } }));
    return;
  }

  const type = String(msg["type"] ?? "");

  if (type === "response.create") {
    if (state.inflight) {
      ws.send(JSON.stringify({ type: "error", error: { message: "A response is already in progress; wait for completion before sending another." } }));
      return;
    }
    state.inflight = true;
    void handleWsResponseCreateNative(ws, state, msg).finally(() => {
      state.inflight = false;
    });
    return;
  }

  ws.send(JSON.stringify({ type: "error", error: { message: `Unknown message type: ${type}` } }));
}

export function onWsClose(ws: ServerWebSocket<WsData>): void {
  const state = getState(ws);
  if (state.timeout !== undefined) clearTimeout(state.timeout);
  connections.delete(ws);
  log.info("responses WS disconnected");
}

export function onWsDrain(ws: ServerWebSocket<WsData>): void {
  void ws;
}

function extractWsJsonFromSse(sse: string): Record<string, unknown> | undefined {
  for (const line of sse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice("data:".length).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // skip unparseable lines
      }
    }
  }
  return undefined;
}

/** Native WebSocket Responses flow. It consumes the same targetProtocol as
 * HTTP, so native Responses upstreams and converted OpenAI/Anthropic routes
 * expose one event contract to clients. */
async function handleWsResponseCreateNative(
  ws: ServerWebSocket<WsData>,
  state: WsConnectionState,
  msg: Record<string, unknown>,
): Promise<void> {
  const requestId = `ws_${++state.requestIdCounter}_${Date.now()}`;
  const parsed = OpenAIResponsesRequest.safeParse(msg);
  if (!parsed.success) {
    ws.send(JSON.stringify({ type: "error", error: { message: `Invalid request: ${parsed.error.message}` } }));
    return;
  }
  if (state.principal === undefined) {
    ws.send(JSON.stringify({ type: "error", error: { message: "Not authenticated" } }));
    return;
  }

  const rawRequest = parsed.data as Record<string, unknown>;
  const storeEnabled = rawRequest["store"] !== false;
  const effectiveRequest = { ...rawRequest };
  delete effectiveRequest["type"];
  const previousId = typeof rawRequest["previous_response_id"] === "string"
    ? rawRequest["previous_response_id"]
    : undefined;
  if (previousId !== undefined) {
    let previousMessages: Array<Record<string, unknown>> | undefined;
    if (state.previousResponseId === previousId) previousMessages = state.previousMessages;
    if (previousMessages === undefined) {
      previousMessages = getGlobalResponseStore().get(previousId, ownerId(state.principal))?.messages;
    }
    if (previousMessages === undefined) {
      ws.send(JSON.stringify({ type: "error", ...previousResponseNotFoundError(previousId) }));
      return;
    }
    const currentInput = rawRequest["input"];
    const history = previousMessages;
    effectiveRequest["input"] = currentInput === undefined
      ? history
      : [...history, ...(Array.isArray(currentInput) ? currentInput : [currentInput])];
    delete effectiveRequest["previous_response_id"];
  }

  const model = effectiveRequest["model"];
  if (typeof model !== "string" || model.length === 0) {
    ws.send(JSON.stringify({ type: "error", error: { message: "model is required" } }));
    return;
  }
  try {
    assertCanUseLogicalModel(state.principal, model);
    const modelConfig = modelConfigLoader.loadConfig(model);
    if (modelConfig.fusion?.enabled === true) {
      ws.send(JSON.stringify({ type: "error", error: { message: "Fusion is not supported over Responses WebSocket" } }));
      return;
    }
  } catch (err) {
    if (err instanceof AccessDeniedError || err instanceof ConfigNotFoundError || err instanceof ConfigParseError || err instanceof ConfigValidationError) {
      ws.send(JSON.stringify({ type: "error", error: { message: `Model '${model}' not found` } }));
      return;
    }
    throw err;
  }

  const requestDict: Record<string, unknown> = { ...effectiveRequest, stream: true };
  await runWithRequestContext(requestId, async () => {
    const startedAt = performance.now();
    const abortController = new AbortController();
    const streamTimeout = setTimeout(() => abortController.abort(), 120_000);
    recordRequestStart({
      requestId,
      endpoint: "/v1/responses",
      method: "WS",
      requestedModel: model,
      resolvedModel: model,
      wireProtocol: "responses",
      isStreaming: true,
      enforceMode: false,
      promptTokens: estimateRequestTokens(requestDict),
      promptTokensEstimated: true,
      requestBody: rawRequest,
      persistCompletions: false,
      userId: state.principal?.userId,
      apiKeyId: state.principal?.apiKeyId,
      principalRole: state.principal?.role,
      ownerBypass: state.principal?.ownerBypass,
    });
    emit({ type: "request.started", at: nowIso(), protocol: "responses", endpoint: "/v1/responses", model, stream: true, enforceEnabled: false });

    let completed: Record<string, unknown> | undefined;
    try {
      const fallback = new FallbackRouter({ principal: state.principal });
      const generator = fallback.streamWithFallback({
        logicalModel: model,
        requestData: requestDict,
        targetProtocol: "responses",
        signal: abortController.signal,
        principal: state.principal,
      });
      for await (const chunk of generator) {
        const wsMsg = extractWsJsonFromSse(chunk);
        if (wsMsg?.["type"] === "response.completed") {
          const response = wsMsg["response"];
          if (typeof response === "object" && response !== null && !Array.isArray(response)) {
            completed = response as Record<string, unknown>;
          }
        }
        if (wsMsg !== undefined) {
          try { ws.send(JSON.stringify(wsMsg)); } catch { return; }
        }
      }
      if (storeEnabled && completed !== undefined && typeof completed["id"] === "string") {
        const chatRequest = responsesRequestToChat(effectiveRequest);
        const messages = (chatRequest["messages"] as Array<Record<string, unknown>> | undefined) ?? [];
        const text = extractResponsesOutputText(completed);
        const storedMessages = [...messages, { role: "assistant", content: text || null }];
        getGlobalResponseStore().set({
          id: completed["id"] as string,
          ownerId: ownerId(state.principal),
          model,
          createdAt: typeof completed["created_at"] === "number" ? completed["created_at"] : Math.floor(Date.now() / 1000),
          status: typeof completed["status"] === "string" ? completed["status"] : "completed",
          messages: storedMessages,
          inputItems: responsesInputItemsForStorage(requestDict, completed),
          response: completed,
          store: true,
        });
        state.previousResponseId = completed["id"] as string;
        state.previousMessages = storedMessages;
      }
      clearTimeout(streamTimeout);
      const totalMs = Math.round(performance.now() - startedAt);
      emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });
      recordRequestFinish({ requestId, responseStatus: 200, responseTimeMs: totalMs });
    } catch (err) {
      clearTimeout(streamTimeout);
      const message = err instanceof Error ? err.message : String(err);
      try { ws.send(JSON.stringify({ type: "error", error: { message } })); } catch { /* closed */ }
      const totalMs = Math.round(performance.now() - startedAt);
      recordRequestFinish({ requestId, responseStatus: 500, responseTimeMs: totalMs, errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
      emit({ type: "request.finished", at: nowIso(), status: 500, totalMs, errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
    }
  });
}
