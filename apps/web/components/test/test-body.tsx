"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/ui/panel";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Composer } from "@/components/test/composer";
import { Thread } from "@/components/test/thread";
import { ToolsPanel } from "@/components/test/tools";
import { EventTimeline } from "@/components/test/event-timeline";
import {
  extractAssistantMessage,
  hasPendingToolCalls,
  mergeOpenAIDeltas,
} from "@/lib/test-extract";
import { buildRequestBody } from "@/lib/test-payload";
import {
  dispatchNonStreaming,
  dispatchStreaming,
  generateRequestId,
  openEventStream,
} from "@/lib/test-dispatch";
import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";
import {
  loadSession,
  saveSession,
  type ThreadMessage,
  type ThreadMessageAnthropic,
  type ThreadMessageOpenAI,
  type ToolDefinition,
  type ParamState,
  type Protocol,
  type TestSessionState,
} from "@/lib/test-session";

interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

export function TestBody({ embedded = false }: { embedded?: boolean }): React.ReactElement {
  const [session, setSession] = useState<TestSessionState>(() => loadSession());
  const [busy, setBusy] = useState<boolean>(false);
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [lastResult, setLastResult] = useState<DispatchResult | undefined>(
    undefined,
  );
  const [statusText, setStatusText] = useState<string>("");
  const [liveAssistant, setLiveAssistant] = useState<
    ThreadMessageOpenAI | undefined
  >(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    saveSession(session);
  }, [session]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const setProtocol = useCallback(
    (protocol: Protocol) => setSession((s) => ({ ...s, protocol })),
    [],
  );
  const setLogicalModel = useCallback(
    (logicalModel: string) => setSession((s) => ({ ...s, logicalModel })),
    [],
  );
  const setParams = useCallback(
    (params: ParamState) => setSession((s) => ({ ...s, params })),
    [],
  );
  const setMessages = useCallback(
    (messages: ThreadMessage[]) => setSession((s) => ({ ...s, messages })),
    [],
  );
  const setTools = useCallback(
    (tools: ToolDefinition[]) => setSession((s) => ({ ...s, tools })),
    [],
  );

  const resetThread = useCallback(() => {
    setSession((s) => ({
      ...s,
      messages: [],
    }));
    setEvents([]);
    setLastResult(undefined);
    setStatusText("");
  }, []);

  const runDispatch = useCallback(
    async (messagesForDispatch: ThreadMessage[]) => {
      if (session.logicalModel.length === 0) return;
      setBusy(true);
      setEvents([]);
      setLastResult(undefined);
      setLiveAssistant(undefined);
      setStatusText("opening stream…");

      const requestId = generateRequestId();
      const abort = new AbortController();
      abortRef.current = abort;

      const body = buildRequestBody(
        session.protocol,
        session.params,
        messagesForDispatch,
        session.tools,
        session.logicalModel,
      );

      const handle = openEventStream(requestId, {
        onEvent: (event) => setEvents((prev) => [...prev, event]),
        onDone: () => setStatusText((s) => (s.startsWith("err:") ? s : "done")),
        onError: () => setStatusText("sse error"),
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      setStatusText("dispatching…");

      try {
        if (session.params.stream) {
          await runStreaming({
            requestId,
            protocol: session.protocol,
            body,
            enforceOverride: session.params.enforceOverride,
            signal: abort.signal,
            onLive: setLiveAssistant,
            onFinal: (assistantMsg, status) => {
              setLastResult({ status, body: { streaming: true } });
              if (assistantMsg !== undefined) {
                setSession((s) => ({
                  ...s,
                  messages: [...messagesForDispatch, assistantMsg],
                }));
              }
              setStatusText(`HTTP ${status}`);
            },
          });
        } else {
          const result = await dispatchNonStreaming({
            requestId,
            protocol: session.protocol,
            body,
            enforceOverride: session.params.enforceOverride,
            signal: abort.signal,
          });
          setLastResult({ status: result.status, body: result.response });
          setStatusText(`HTTP ${result.status}`);
          if (result.status >= 200 && result.status < 300) {
            const assistantMsg = extractAssistantMessage(
              session.protocol,
              result.response,
            );
            if (assistantMsg !== undefined) {
              setSession((s) => ({
                ...s,
                messages: [...messagesForDispatch, assistantMsg],
              }));
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setStatusText(`err: ${(err as Error).message}`);
        }
      } finally {
        setBusy(false);
        setLiveAssistant(undefined);
        handle.close();
        abortRef.current = undefined;
      }
    },
    [
      session.logicalModel,
      session.params,
      session.protocol,
      session.tools,
    ],
  );

  const handleSubmitChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || session.logicalModel.length === 0) return;
      const userMsg =
        session.protocol === "openai"
          ? ({ role: "user", content: trimmed } satisfies ThreadMessageOpenAI)
          : ({ role: "user", content: trimmed } satisfies ThreadMessageAnthropic);
      const next = [...session.messages, userMsg];
      setSession((s) => ({ ...s, messages: next }));
      runDispatch(next);
    },
    [runDispatch, session.logicalModel.length, session.messages, session.protocol],
  );

  const handleContinueWithToolResults = useCallback<
    React.ComponentProps<typeof Thread>["onContinueWithToolResults"]
  >(
    (replies) => {
      if (session.protocol === "openai") {
        const toolMessages: ThreadMessageOpenAI[] = replies
          .filter((r): r is Extract<typeof r, { kind: "openai" }> => r.kind === "openai")
          .map((r) => r.message);
        const next = [...session.messages, ...toolMessages];
        setSession((s) => ({ ...s, messages: next }));
        runDispatch(next);
      } else {
        const lastIdx = session.messages.length - 1;
        const last = session.messages[lastIdx];
        if (last === undefined) return;
        const toolBlocks = replies
          .filter(
            (r): r is Extract<typeof r, { kind: "anthropic" }> =>
              r.kind === "anthropic",
          )
          .map((r) => r.block);
        const userMsg: ThreadMessageAnthropic = {
          role: "user",
          content: toolBlocks as ThreadMessageAnthropic["content"] extends string
            ? never
            : Exclude<ThreadMessageAnthropic["content"], string>,
        };
        const next = [...session.messages, userMsg];
        setSession((s) => ({ ...s, messages: next }));
        runDispatch(next);
      }
    },
    [session.messages, session.protocol, runDispatch],
  );

  const hasPending =
    session.messages.length > 0 &&
    hasPendingToolCalls(
      session.protocol,
      session.messages[session.messages.length - 1] as ThreadMessage,
    );

  const statusActions = (
    <div className="flex items-center gap-2">
      {hasPending ? (
        <Badge tone="warning">tool calls pending</Badge>
      ) : null}
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300">
        {statusText}
      </span>
      <StatusDot tone={busy ? "phosphor" : "muted"} />
    </div>
  );

  return (
    <>
      {embedded ? (
        <div className="mb-6 flex flex-wrap items-center justify-end gap-2">{statusActions}</div>
      ) : (
        <PageHeader
          eyebrow="test"
          title="Request workbench"
          description="Fire arbitrary completions at your configured models, provide fake tool results to continue agentic loops, and watch the proxy's per-request event stream in real time."
          actions={statusActions}
        />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,9fr)]">
        <div className="flex min-h-0 flex-col gap-5">
          <Panel
            title="composer"
            accent
            className="flex h-[520px] shrink-0 flex-col overflow-hidden"
            bodyClassName="min-h-0 flex-1 flex flex-col overflow-hidden"
          >
            <Composer
              protocol={session.protocol}
              onProtocolChange={setProtocol}
              logicalModel={session.logicalModel}
              onLogicalModelChange={setLogicalModel}
              params={session.params}
              onParamsChange={setParams}
              busy={busy}
            />
          </Panel>

          <Panel
            title="tools"
            accent
            className="min-h-0 shrink-0 overflow-hidden"
          >
            <ToolsPanel tools={session.tools} onChange={setTools} />
          </Panel>

          <Panel
            title="events"
            accent
            className="flex h-[220px] min-h-0 shrink-0 flex-col overflow-hidden"
            bodyClassName="min-h-0 flex-1 flex flex-col overflow-hidden"
          >
            <EventTimeline
              events={events}
              live={busy}
              compact
              onClear={() => setEvents([])}
            />
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel
            title="thread"
            accent
            className="flex h-[520px] flex-col overflow-hidden"
            bodyClassName="min-h-0 flex-1 flex flex-col overflow-hidden"
          >
            <Thread
              protocol={session.protocol}
              messages={session.messages}
              onMessagesChange={setMessages}
              busy={busy}
              onContinueWithToolResults={handleContinueWithToolResults}
              liveAssistant={liveAssistant}
              logicalModel={session.logicalModel}
              onSubmitChat={handleSubmitChat}
              onResetThread={resetThread}
              toolCallsPending={hasPending}
            />
          </Panel>

          {lastResult !== undefined ? (
            <Panel
              title="raw response"
              accent
              subtitle={`HTTP ${lastResult.status}`}
            >
              <pre className="max-h-[300px] overflow-auto bg-ink-700 p-3 font-mono text-[11px] text-bone-700 shadow-edge">
                {JSON.stringify(lastResult.body, null, 2)}
              </pre>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}

async function runStreaming(options: {
  requestId: string;
  protocol: Protocol;
  body: Record<string, unknown>;
  enforceOverride: ParamState["enforceOverride"];
  signal: AbortSignal;
  onLive: (msg: ThreadMessageOpenAI | undefined) => void;
  onFinal: (assistantMsg: ThreadMessageOpenAI | undefined, status: number) => void;
}): Promise<void> {
  let accumulated: ThreadMessageOpenAI = { role: "assistant", content: "" };
  let status = 0;

  const generator = options.protocol === "openai"
    ? dispatchStreaming({
        requestId: options.requestId,
        protocol: "openai",
        body: options.body,
        enforceOverride: options.enforceOverride,
        signal: options.signal,
      })
    : dispatchStreaming({
        requestId: options.requestId,
        protocol: "anthropic",
        body: options.body,
        enforceOverride: options.enforceOverride,
        signal: options.signal,
      });

  for await (const frame of generator) {
    status = 200;
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (options.protocol === "openai") {
          const choices = parsed["choices"];
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const delta = ((choices[0] as Record<string, unknown>)?.["delta"] ?? {}) as Record<
            string,
            unknown
          >;
          accumulated = mergeOpenAIDeltas(accumulated, delta);
          options.onLive(accumulated);
        } else {
          const type = parsed["type"];
          if (
            type === "content_block_delta" &&
            typeof (parsed["delta"] as Record<string, unknown>)?.["text"] === "string"
          ) {
            const text = (parsed["delta"] as Record<string, unknown>)["text"] as string;
            accumulated.content =
              (typeof accumulated.content === "string" ? accumulated.content : "") + text;
            options.onLive(accumulated);
          }
        }
      } catch {
        // ignore malformed frames
      }
    }
  }
  options.onFinal(accumulated, status || 200);
}
