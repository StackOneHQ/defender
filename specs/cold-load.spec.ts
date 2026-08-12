import { describe, it, expect } from 'vitest';
import { createPromptDefense } from '../src/core/prompt-defense';

// The ONNX model session is a process-wide singleton, so whether the FIRST call
// is a genuine cold start depends on prior model loads in the same process — not
// something we can force in a shared test run. So assert the invariant the fix
// establishes instead: coldLoad reflects the model's ready state BEFORE the call.
// The bug sampled it AFTER prepareChunks warmed the model, so it was always false;
// this fails against that bug whenever the model actually loads on the call.
describe.skipIf(!!process.env.CI)('coldLoad — cold-start telemetry', () => {
  it('coldLoad === (model was not ready before the call); warm afterwards', async () => {
    const defense = createPromptDefense({});
    const wasReady = defense.isTier2Ready();
    const first = await defense.defendToolResult({ content: 'first call with enough text to classify' }, 'docs_get');
    // Reflects the PRE-call ready state — true iff the model loaded on this call.
    expect(first.coldLoad).toBe(!wasReady);
    // The model is definitely loaded now, so the next call is warm.
    const second = await defense.defendToolResult({ content: 'second call with enough text to classify' }, 'docs_get');
    expect(second.coldLoad).toBe(false);
  }, 60000);
});
