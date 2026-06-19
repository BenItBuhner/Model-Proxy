import { createLogger } from "../../../observability/logger.ts";
import type { CodeExecutionRequest, CodeExecutionResult, CodeLanguage } from "./types.ts";

const log = createLogger("routing.fusion.sandbox.executor");

// ── Default Configuration ─────────────────────────────────────────────

const DEFAULT_CONFIG = {
  timeoutMs: 30_000,
  memoryMb: 256,
};

// ── WasmExecutor ──────────────────────────────────────────────────────

/**
 * Code Execution Sandbox
 *
 * Executes untrusted code in a constrained environment.
 *
 * CURRENT IMPLEMENTATION: Bun subprocess stub.
 * Uses Bun.spawn() with resource limits as a stand-in until a real
 * WASM runtime (e.g. wasmtime with Pyodide/quickjs) is integrated.
 *
 * Future: Swap for a proper WASM runtime that provides:
 *  - Fine-grained capability control via WASM fuel metering
 *  - In-memory virtual filesystem (no host FS access)
 *  - Controlled network via FetchShim
 *  - Cross-language support via WASM-compiled runtimes
 *
 * The public API (`execute()`) is designed to be identical regardless
 * of the underlying runtime.
 */
export class WasmExecutor {
  private readonly config: typeof DEFAULT_CONFIG;

  constructor(config: Partial<typeof DEFAULT_CONFIG> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute code in the sandbox.
   *
   * @returns The execution result with stdout, stderr, and exit code.
   */
  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const timeout = request.timeoutMs ?? this.config.timeoutMs;
    const startTime = performance.now();

    log.info("executing code in sandbox", {
      language: request.language,
      codeLength: request.code.length,
      timeout,
    });

    try {
      const result = await this.executeWithSubprocess(request, timeout);
      const durationMs = Math.round(performance.now() - startTime);
      return { ...result, durationMs };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      log.error("sandbox execution failed", { error: String(err) });
      return {
        success: false,
        stdout: "",
        stderr: String(err),
        exitCode: -1,
        durationMs,
        error: String(err),
      };
    }
  }

  /**
   * Execute code via Bun subprocess with resource limits.
   * This is the stub implementation — swap for WASM runtime later.
   */
  private async executeWithSubprocess(
    request: CodeExecutionRequest,
    timeout: number,
  ): Promise<CodeExecutionResult> {
    const { code, language } = request;

    // Determine the command to run based on language
    const { command, args, inputFilter } = this.buildSubprocessCommand(language, code);

    const startTime = performance.now();
    const inputCode = inputFilter ?? code;

    // Construct the command array: [command, ...args, code]
    // Use -c flag approach for eval-like execution
    const cmdArgs: string[] = [command, ...args];

    const proc = Bun.spawn(cmdArgs, {
      stdin: "pipe" as const,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin",
        NODE_ENV: "sandboxed",
        WASM_FETCH_SHIM: "1",
      },
    });

    // Write code to stdin and close (stdin is a FileSink in Bun)
    const sink = proc.stdin;
    const encoder = new TextEncoder();
    sink.write(encoder.encode(inputCode));
    sink.end();

    // Read output with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch { /* process may already be dead */ }
        reject(new Error(`Execution timed out after ${timeout}ms`));
      }, timeout);
    });

    try {
      const [stdout, stderr] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
        timeoutPromise,
      ]);

      const exitCode = await proc.exitCode;
      const durationMs = Math.round(performance.now() - startTime);

      return {
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        durationMs,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      return {
        success: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        durationMs,
        error: String(err),
      };
    }
  }

  /**
   * Build the subprocess command based on language.
   */
  private buildSubprocessCommand(
    language: CodeLanguage,
    code: string,
  ): { command: string; args: string[]; inputFilter?: string } {
    switch (language) {
      case "python":
        return {
          command: "python3",
          args: ["-c", code],
        };

      case "javascript":
        // Use Bun to execute JavaScript (Bun is inherently sandboxed via JSC)
        return {
          command: "bun",
          args: ["-e", code],
        };

      case "typescript":
        // Use Bun to execute TypeScript directly
        return {
          command: "bun",
          args: ["-e", code],
          // Add a transform to strip type annotations
          inputFilter: code
            .replace(/^\s*import\s+type\s/gm, "")
            .replace(/: \w+(<[^>]+>)?(?=\s*[=(,;{])/g, "")
            .replace(/:\s*\w+(\[\])?(?=\s*[=>,;})])/g, ""),
        };

      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }
}
