# Examples

Runnable TypeScript examples for `@stackone/defender`. Node runs them directly (type stripping, Node 22.18+), so there is no build step for the examples themselves. They import the package by name, which resolves to this repo's build.

```bash
pnpm install
pnpm build                                   # the examples use dist/
pnpm example examples/01-basic.ts            # run one
pnpm examples:smoke                          # run all (LLM examples skip without keys)
pnpm examples:typecheck                      # typecheck against the package's public types
```

| Example | Shows | Needs |
|---|---|---|
| [`01-basic.ts`](./01-basic.ts) | `defendToolResult` with the defaults (Tier 1 + Tier 2), `allowed` vs `riskLevel` | nothing |
| [`02-batch-and-boundary.ts`](./02-batch-and-boundary.ts) | `defendToolResults`, detect-and-gate (`sanitizeContent: false`), boundary annotation | nothing |
| [`03-tier3-openai-compatible.ts`](./03-tier3-openai-compatible.ts) | Tier 3 with an OpenAI-compatible endpoint: OpenAI, Gemini or local Ollama | `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OLLAMA=1` |
| [`04-tier3-any-llm.ts`](./04-tier3-any-llm.ts) | Tier 3 with any LLM via `createLlmTier3Provider` (Anthropic API, plain `fetch`), a custom prompt, caller context | `ANTHROPIC_API_KEY` |
| [`05-tier3-policy.ts`](./05-tier3-policy.ts) | `allowOverride`, `onError`, `decide`, `timeoutMs`, `maxConcurrency`, `stopOnFirstBlock`, `onEvent` | nothing (scripted judges) |
| [`06-agent-loop.ts`](./06-agent-loop.ts) | Where defender sits in an agent loop: defend each tool result before the model sees it | nothing |

Set `TIER3_MODEL` to change the judge model in 03 and 04.

Keys are read from the environment only. Don't commit them.
