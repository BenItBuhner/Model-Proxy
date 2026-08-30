"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type {
  Protocol,
  ThreadMessage,
  ThreadMessageAnthropic,
  ThreadMessageOpenAI,
} from "@/lib/test-session";

interface ThreadProps {
  protocol: Protocol;
  messages: ThreadMessage[];
  onMessagesChange: (msgs: ThreadMessage[]) => void;
  /** True while a request is in flight — disables most controls. */
  busy: boolean;
  /**
   * If the last assistant message has pending tool calls, this handler is
   * invoked after the user fills stubs and clicks "continue". The caller
   * should append the tool replies + re-dispatch with the full thread.
   */
  onContinueWithToolResults: (
    replies: Array<
      | { kind: "openai"; message: ThreadMessageOpenAI }
      | { kind: "anthropic"; block: NonNullable<ThreadMessageAnthropic["content"]>[number] }
    >,
  ) => void;
  /** Streaming text for the in-flight assistant turn (live). */
  liveAssistant?: ThreadMessageOpenAI | undefined;
  /** Required to enable send — pick a model in the composer panel. */
  logicalModel: string;
  /** Append `{ role: user, content }` and dispatch (parent owns network). */
  onSubmitChat: (text: string) => void;
  /** Clear thread history + local draft. */
  onResetThread: () => void;
  /** Last turn is waiting on fake tool results — chat input is disabled. */
  toolCallsPending: boolean;
}

export function Thread(props: ThreadProps): React.ReactElement {
  const { protocol, messages, onMessagesChange, busy, liveAssistant } = props;
  const [draft, setDraft] = useState<string>("");

  const canSend =
    props.logicalModel.trim().length > 0 &&
    !busy &&
    !props.toolCallsPending &&
    draft.trim().length > 0;

  function submitChat(): void {
    if (!canSend) return;
    const text = draft.trim();
    props.onSubmitChat(text);
    setDraft("");
  }

  function handleResetThread(): void {
    setDraft("");
    props.onResetThread();
  }

  function updateAt(index: number, patch: Partial<ThreadMessageOpenAI | ThreadMessageAnthropic>): void {
    const next = [...messages];
    const existing = next[index];
    if (existing === undefined) return;
    next[index] = { ...(existing as object), ...(patch as object) } as ThreadMessage;
    onMessagesChange(next);
  }

  function removeAt(index: number): void {
    const next = messages.filter((_, i) => i !== index);
    onMessagesChange(next);
  }

  function addSystemMessage(): void {
    if (protocol === "openai") {
      onMessagesChange([{ role: "system", content: "" } as ThreadMessageOpenAI, ...messages]);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-5 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-bone-500">
              No messages yet
            </p>
            <p className="max-w-[28ch] font-mono text-[10px] leading-relaxed text-bone-300">
              Type in the field below and send to start. OpenAI: use + system to prepend a system
              turn.
            </p>
          </div>
        ) : null}
        {messages.map((message, index) => (
          <MessageCard
            key={index}
            protocol={protocol}
            message={message}
            index={index}
            busy={busy}
            isLast={index === messages.length - 1}
            onChange={(patch) => updateAt(index, patch)}
            onRemove={() => removeAt(index)}
            onContinue={props.onContinueWithToolResults}
          />
        ))}
        {liveAssistant !== undefined ? (
          <LiveAssistantCard message={liveAssistant} />
        ) : null}
      </div>

      <div className="shrink-0 border-t border-ink-500 bg-ink-900/50 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {protocol === "openai" ? (
            <Button variant="ghost" size="sm" onClick={addSystemMessage} disabled={busy}>
              + system
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={handleResetThread} disabled={busy}>
            reset thread
          </Button>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
            {messages.length} {messages.length === 1 ? "msg" : "msgs"}
          </span>
        </div>

        {props.toolCallsPending ? (
          <p className="rounded-sm border border-bone-300/20 bg-ink-800 px-3 py-2 font-mono text-[10px] text-bone-500">
            Tool calls pending — fill results above and use &ldquo;continue&rdquo; to dispatch.
          </p>
        ) : (
          <div className="flex gap-2">
            <textarea
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey) return;
                if (!canSend) return;
                e.preventDefault();
                submitChat();
              }}
              placeholder={
                props.logicalModel.trim().length === 0
                  ? "Pick a logical model in the composer, then send…"
                  : busy
                    ? "Waiting for response…"
                    : "Message the model…"
              }
              disabled={busy}
              className="min-h-[44px] max-h-[160px] min-w-0 flex-1 resize-y rounded-sm border border-ink-500 bg-ink-800 px-3 py-2.5 font-mono text-[13px] leading-snug text-bone-900 placeholder:text-bone-300 shadow-inner focus:border-phosphor-500/60 focus:outline-none focus:ring-1 focus:ring-phosphor-500/40 disabled:opacity-50"
            />
            <Button
              className="h-[44px] shrink-0 self-end px-5"
              onClick={submitChat}
              disabled={!canSend}
            >
              {busy ? "…" : "send"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageCard({
  protocol,
  message,
  index,
  busy,
  isLast,
  onChange,
  onRemove,
  onContinue,
}: {
  protocol: Protocol;
  message: ThreadMessage;
  index: number;
  busy: boolean;
  isLast: boolean;
  onChange: (patch: Partial<ThreadMessageOpenAI | ThreadMessageAnthropic>) => void;
  onRemove: () => void;
  onContinue: ThreadProps["onContinueWithToolResults"];
}): React.ReactElement {
  const [rawMode, setRawMode] = useState<boolean>(false);
  const tone = roleTone(message.role);

  return (
    <div className="bg-ink-700 shadow-edge">
      <div className="flex items-center justify-between border-b border-ink-500 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
            {index.toString().padStart(2, "0")}
          </span>
          <Badge tone={tone}>{message.role}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRawMode((m) => !m)}
            className="h-6 px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300 hover:text-bone-900"
          >
            {rawMode ? "structured" : "raw JSON"}
          </button>
          <button
            onClick={onRemove}
            disabled={busy}
            className="h-6 px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300 hover:text-alert-500 disabled:opacity-30"
          >
            remove
          </button>
        </div>
      </div>

      <div className="p-3">
        {rawMode ? (
          <RawEditor message={message} onChange={onChange} />
        ) : protocol === "openai" ? (
          <OpenAIMessageEditor
            message={message as ThreadMessageOpenAI}
            onChange={onChange as (p: Partial<ThreadMessageOpenAI>) => void}
            busy={busy}
            isLast={isLast}
            onContinue={onContinue}
          />
        ) : (
          <AnthropicMessageEditor
            message={message as ThreadMessageAnthropic}
            onChange={onChange as (p: Partial<ThreadMessageAnthropic>) => void}
            busy={busy}
            isLast={isLast}
            onContinue={onContinue}
          />
        )}
      </div>
    </div>
  );
}

function RawEditor({
  message,
  onChange,
}: {
  message: ThreadMessage;
  onChange: (patch: ThreadMessage) => void;
}): React.ReactElement {
  const [text, setText] = useState<string>(JSON.stringify(message, null, 2));
  const [error, setError] = useState<string | undefined>(undefined);
  function commit(raw: string): void {
    setText(raw);
    try {
      const parsed = JSON.parse(raw) as ThreadMessage;
      setError(undefined);
      onChange(parsed);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <>
      <textarea
        rows={Math.max(5, text.split("\n").length)}
        value={text}
        onChange={(e) => commit(e.target.value)}
        className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
      />
      {error !== undefined ? (
        <div className="mt-1 font-mono text-[10px] text-alert-500">{error}</div>
      ) : null}
    </>
  );
}

function OpenAIMessageEditor({
  message,
  onChange,
  busy,
  isLast,
  onContinue,
}: {
  message: ThreadMessageOpenAI;
  onChange: (patch: Partial<ThreadMessageOpenAI>) => void;
  busy: boolean;
  isLast: boolean;
  onContinue: ThreadProps["onContinueWithToolResults"];
}): React.ReactElement {
  const hasToolCalls =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  if (message.role === "tool") {
    return (
      <div className="space-y-2">
        <Input
          monospace
          placeholder="tool_call_id"
          value={message.tool_call_id ?? ""}
          onChange={(e) => onChange({ tool_call_id: e.target.value })}
        />
        <textarea
          rows={3}
          value={
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content)
          }
          onChange={(e) => onChange({ content: e.target.value })}
          className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        rows={Math.max(2, String(message.content ?? "").split("\n").length)}
        placeholder={
          message.role === "system" ? "system instructions..." : "message content..."
        }
        value={typeof message.content === "string" ? message.content : message.content === null ? "" : ""}
        onChange={(e) => onChange({ content: e.target.value })}
        className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
      />
      {hasToolCalls ? (
        <ToolCallStubsOpenAI
          toolCalls={message.tool_calls ?? []}
          isLast={isLast}
          busy={busy}
          onContinue={onContinue}
        />
      ) : null}
    </div>
  );
}

function ToolCallStubsOpenAI({
  toolCalls,
  isLast,
  busy,
  onContinue,
}: {
  toolCalls: NonNullable<ThreadMessageOpenAI["tool_calls"]>;
  isLast: boolean;
  busy: boolean;
  onContinue: ThreadProps["onContinueWithToolResults"];
}): React.ReactElement {
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  function handleContinue(): void {
    const replies = toolCalls.map(
      (tc) =>
        ({
          kind: "openai",
          message: {
            role: "tool",
            tool_call_id: tc.id,
            content: outputs[tc.id] ?? "",
          },
        }) as const,
    );
    onContinue(replies);
    setOutputs({});
  }

  return (
    <div className="mt-2 space-y-2 border-l-2 border-phosphor-500/40 pl-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-phosphor-500">
        Pending tool calls ({toolCalls.length})
      </div>
      {toolCalls.map((tc) => (
        <div key={tc.id} className="bg-ink-800 p-2 shadow-edge space-y-1.5">
          <div className="font-mono text-[11px] text-bone-900">
            {tc.function.name}
            <span className="text-bone-300"> · </span>
            <span className="text-bone-500">{tc.id.slice(0, 12)}</span>
          </div>
          <pre className="bg-ink-700 p-2 font-mono text-[10px] text-bone-500 overflow-x-auto">
            {tc.function.arguments || "{}"}
          </pre>
          <textarea
            rows={2}
            placeholder={`paste fake result for ${tc.function.name}`}
            value={outputs[tc.id] ?? ""}
            onChange={(e) =>
              setOutputs((prev) => ({ ...prev, [tc.id]: e.target.value }))
            }
            className="w-full bg-ink-700 px-2 py-1 text-[12px] leading-5 text-bone-900 shadow-edge font-mono"
          />
        </div>
      ))}
      {isLast ? (
        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={handleContinue} disabled={busy}>
            continue with tool results →
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AnthropicMessageEditor({
  message,
  onChange,
  busy,
  isLast,
  onContinue,
}: {
  message: ThreadMessageAnthropic;
  onChange: (patch: Partial<ThreadMessageAnthropic>) => void;
  busy: boolean;
  isLast: boolean;
  onContinue: ThreadProps["onContinueWithToolResults"];
}): React.ReactElement {
  // If content is a string we just edit it directly; once it becomes block-
  // shaped we render per-block.
  if (typeof message.content === "string") {
    return (
      <textarea
        rows={Math.max(2, message.content.split("\n").length)}
        placeholder="message content..."
        value={message.content}
        onChange={(e) => onChange({ content: e.target.value })}
        className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
      />
    );
  }

  const toolUses = message.content.filter((b) => b.type === "tool_use") as Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;

  return (
    <div className="space-y-2">
      {message.content.map((block, index) => {
        if (block.type === "text") {
          return (
            <textarea
              key={index}
              rows={Math.max(2, block.text.split("\n").length)}
              value={block.text}
              onChange={(e) => {
                const next = [...message.content as Array<unknown>];
                next[index] = { ...block, text: e.target.value };
                onChange({ content: next as ThreadMessageAnthropic["content"] });
              }}
              className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
            />
          );
        }
        if (block.type === "tool_use") {
          return (
            <div key={block.id} className="bg-ink-800 p-2 shadow-edge">
              <div className="font-mono text-[11px] text-bone-900">
                tool_use · {block.name}
              </div>
              <pre className="bg-ink-700 mt-1 p-2 font-mono text-[10px] text-bone-500 overflow-x-auto">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          );
        }
        if (block.type === "tool_result") {
          return (
            <div key={index} className="bg-ink-800 p-2 shadow-edge">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">
                tool_result · {block.tool_use_id.slice(0, 12)}
              </div>
              <pre className="bg-ink-700 mt-1 p-2 font-mono text-[11px] text-bone-700 overflow-x-auto">
                {typeof block.content === "string" ? block.content : JSON.stringify(block.content)}
              </pre>
            </div>
          );
        }
        return null;
      })}
      {toolUses.length > 0 ? (
        <ToolUseStubsAnthropic
          blocks={toolUses}
          isLast={isLast}
          busy={busy}
          onContinue={onContinue}
        />
      ) : null}
    </div>
  );
}

function ToolUseStubsAnthropic({
  blocks,
  isLast,
  busy,
  onContinue,
}: {
  blocks: Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  isLast: boolean;
  busy: boolean;
  onContinue: ThreadProps["onContinueWithToolResults"];
}): React.ReactElement {
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  function handleContinue(): void {
    const replies = blocks.map(
      (b) =>
        ({
          kind: "anthropic",
          block: {
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: outputs[b.id] ?? "",
            is_error: false,
          },
        }) as const,
    );
    onContinue(replies);
    setOutputs({});
  }

  return (
    <div className="border-l-2 border-phosphor-500/40 pl-3 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-phosphor-500">
        Pending tool_use blocks ({blocks.length})
      </div>
      {blocks.map((b) => (
        <div key={b.id} className="bg-ink-800 p-2 shadow-edge space-y-1.5">
          <div className="font-mono text-[11px] text-bone-900">
            {b.name} <span className="text-bone-300">·</span>{" "}
            <span className="text-bone-500">{b.id.slice(0, 12)}</span>
          </div>
          <textarea
            rows={2}
            placeholder={`paste fake result for ${b.name}`}
            value={outputs[b.id] ?? ""}
            onChange={(e) =>
              setOutputs((prev) => ({ ...prev, [b.id]: e.target.value }))
            }
            className="w-full bg-ink-700 px-2 py-1 text-[12px] leading-5 text-bone-900 shadow-edge font-mono"
          />
        </div>
      ))}
      {isLast ? (
        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={handleContinue} disabled={busy}>
            continue →
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LiveAssistantCard({
  message,
}: {
  message: ThreadMessageOpenAI;
}): React.ReactElement {
  return (
    <div className="bg-ink-700 shadow-edge-phosphor">
      <div className="flex items-center gap-2 border-b border-phosphor-500/40 px-3 py-1.5">
        <Badge tone="phosphor">assistant · live</Badge>
      </div>
      <div className="p-3">
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-6 text-bone-900">
          {typeof message.content === "string" ? message.content : ""}
        </pre>
      </div>
    </div>
  );
}

function roleTone(role: string): "phosphor" | "bone" | "warning" | "muted" {
  switch (role) {
    case "system":
      return "warning";
    case "user":
      return "bone";
    case "assistant":
      return "phosphor";
    default:
      return "muted";
  }
}
