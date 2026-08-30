"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";

export default function DocsPage(): React.ReactElement {
  const [baseUrl, setBaseUrl] = useState<string>("https://your-proxy.example/v1");
  useEffect(() => {
    setBaseUrl(`${window.location.origin}/v1`);
  }, []);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="docs" title="Client Setup" description="OpenAI-compatible SDKs and agent configuration." />
      <Snippet title="OpenAI SDK" text={`baseURL: "${baseUrl}"\napiKey: "mpu_..."\nmodel: "your-allowed-model"`} />
      <Snippet title="curl smoke test" text={`curl ${baseUrl}/models \\\n  -H "Authorization: Bearer mpu_..."`} />
      <Snippet title="OpenCode" text={`{\n  "provider": {\n    "model-proxy": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "${baseUrl}" }\n    }\n  }\n}`} />
      <Snippet title="Zed / Codex / Claude Code" text={`Use OpenAI-compatible provider settings:\nbase URL: ${baseUrl}\nAPI key: mpu_...\nmodel: one of the models visible from /v1/models`} />
    </div>
  );
}

function Snippet({ title, text }: { title: string; text: string }): React.ReactElement {
  return (
    <Panel title={title}>
      <PanelBody>
        <pre className="overflow-auto bg-ink-900 p-4 text-xs text-bone-900">{text}</pre>
      </PanelBody>
    </Panel>
  );
}
