# Fusion Quality Review

## Current Result
The local `fusion-beta` quality harness now checks hard software-engineering and mathematics routing behavior without live provider calls. The strongest mocked gauntlet proves that a TypeScript scheduler plus starvation-proof prompt escalates to Effort 3, preserves four distinct model routes, seals subagents from tool use, strips fake action/tool artifacts, keeps advisory handoff terse, and leaves real tools available only to the final fusing model.

The scorecard benchmark currently evaluates three expected-pass hard cases and one expected-fail negative control:
- TypeScript scheduler proof and rollout.
- Rust async backpressure proof.
- Symbolic math kernel correctness.
- Duplicated, unsafe, low-context advisories that must fail.

## Latest Safe Commands
Use these commands for low-resource local review:

```sh
bun run eval:fusion-scorecard
bun run eval:fusion-quality
```

Use these broader gates before committing Fusion changes:

```sh
bun test
bun run typecheck
bun run build
git diff --check
```

## Latest Evidence
Latest focused scorecard run:
- Gate: pass.
- Expected-pass cases: 3.
- Expected-fail cases: 1.
- Unexpected cases: 0.
- Minimum overall score: 0.601, from the expected-fail negative control.
- Average overall score: 0.9.
- Resource headroom: about 987 ms and 60 MB under the configured limits.

Latest focused Fusion quality run:
- `bun run eval:fusion-quality` passed 11 tests / 95 assertions.

Static gates:
- `bun run typecheck` passed.
- `bun run build` passed.
- `git diff --check` passed.

## What This Proves
- SWE/math-heavy prompts are recognized strongly enough to trigger full Fusion.
- The divider can preserve diverse requested model routings across software, math, algorithm, and testing subtasks.
- Subagents remain advisory-only: no tools, `tool_choice: "none"`, no fake tool-call artifacts, and no claims of executed work.
- The final fuser retains authority over real tools.
- Advisory handoff is concise and checked for duplication, context coverage, safety, and final-tool authority.
- The benchmark can reject a deliberately bad trace instead of only approving golden fixtures.
- The benchmark stays cheap enough for local use alongside other workloads.

## What This Does Not Prove
These local mocked evaluations do not prove real GPT-5.5/GPT-5.6 or Anthropic Fable parity. That claim would require live model runs against external SWE/math benchmarks with fixed prompts, provider versions, rate limits, cost limits, and resource monitoring.

## Live Eval Requirements
Before running live benchmark work on this machine:
- Cap concurrency to avoid interfering with active services and Rust builds.
- Set explicit provider, token, cost, and timeout budgets.
- Prefer small SWE/math slices first, then expand only if resource headroom is confirmed.
- Capture raw prompts, model routes, scorecard output, and resource telemetry.
- Keep subagents sealed unless the Fusion contract is intentionally redesigned.
