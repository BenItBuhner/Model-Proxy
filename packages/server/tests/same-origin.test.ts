import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { isSameOriginMutation } from "../src/server/same-origin.ts";

const app = new Hono();
app.post("/probe", (c) => c.json({ ok: isSameOriginMutation(c) }));
app.get("/probe", (c) => c.json({ ok: isSameOriginMutation(c) }));

async function probe(
  url: string,
  headers: Record<string, string>,
  method = "POST",
): Promise<boolean> {
  const response = await app.request(new Request(url, { method, headers }));
  const body = (await response.json()) as { ok: boolean };
  return body.ok;
}

describe("isSameOriginMutation", () => {
  test("allows same-host mutation with https origin while the app sees http", async () => {
    // Cloudflare tunnel terminates TLS; the app sees http:// on the Host header.
    const ok = await probe("http://infer.techlitnow.com/probe", {
      host: "infer.techlitnow.com",
      origin: "https://infer.techlitnow.com",
    });
    expect(ok).toBe(true);
  });

  test("allows mutations when X-Forwarded-Host carries the public domain", async () => {
    const ok = await probe("http://127.0.0.1:9876/probe", {
      host: "proxy-green:9876",
      "x-forwarded-host": "infer.techlitnow.com",
      origin: "https://infer.techlitnow.com",
    });
    expect(ok).toBe(true);
  });

  test("allows mutations with an explicit non-default port on both sides", async () => {
    const ok = await probe("http://site.test:9876/probe", {
      host: "site.test:9876",
      origin: "https://site.test:9876",
    });
    expect(ok).toBe(true);
  });

  test("allows mutations when CORS_ORIGINS names the public origin", async () => {
    process.env.CORS_ORIGINS = "https://infer.techlitnow.com";
    try {
      const ok = await probe("http://127.0.0.1:9876/probe", {
        host: "127.0.0.1:9876",
        origin: "https://infer.techlitnow.com",
      });
      expect(ok).toBe(true);
    } finally {
      delete process.env.CORS_ORIGINS;
    }
  });

  test("CORS_ORIGINS=* skips the origin check entirely", async () => {
    process.env.CORS_ORIGINS = "*";
    try {
      const ok = await probe("http://127.0.0.1:9876/probe", {
        host: "127.0.0.1:9876",
        origin: "https://evil.example",
      });
      expect(ok).toBe(true);
    } finally {
      delete process.env.CORS_ORIGINS;
    }
  });

  test("rejects cross-site origins", async () => {
    const ok = await probe("http://infer.techlitnow.com/probe", {
      host: "infer.techlitnow.com",
      origin: "https://evil.example",
    });
    expect(ok).toBe(false);
  });

  test("rejects a same-scheme lookalike host", async () => {
    const ok = await probe("http://infer.techlitnow.com/probe", {
      host: "infer.techlitnow.com",
      origin: "https://infer.techlitnow.com.evil.example",
    });
    expect(ok).toBe(false);
  });

  test("allows requests without an Origin header (API clients)", async () => {
    const ok = await probe("http://127.0.0.1:9876/probe", {
      host: "127.0.0.1:9876",
    });
    expect(ok).toBe(true);
  });

  test("rejects null origins", async () => {
    const ok = await probe("http://127.0.0.1:9876/probe", {
      host: "127.0.0.1:9876",
      origin: "null",
    });
    expect(ok).toBe(false);
  });

  test("GET requests always pass", async () => {
    const ok = await probe(
      "http://evil.example/probe",
      { origin: "https://evil.example" },
      "GET",
    );
    expect(ok).toBe(true);
  });
});
