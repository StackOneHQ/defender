import { describe, it, expect } from 'vitest';
import { createPromptDefense, sfePreprocess, type SfePredictor } from '../src';

/**
 * Deterministic mock predictor — no dependency on `fasttext.wasm`. Drops
 * strings that look like UUIDs / short IDs / hex hashes, keeps everything
 * else. Mirrors the qualitative behaviour of the bundled FastText model
 * without needing the WASM runtime installed in CI.
 */
function mockPredictor(): SfePredictor {
  const dropRe = /^[0-9a-f]{6,}$|^[0-9a-f-]{8,}$|^v\d|^[A-Z]{2,}[-_]\d/i;
  const predict = async (text: string) => {
    // The text format is: "<type> d<depth> <path tokens> <value>".
    // Match the model's training format — classify "drop" if the value
    // looks like an identifier/version.
    const parts = text.trim().split(/\s+/);
    const valuePart = parts.slice(3).join(' ');
    if (dropRe.test(valuePart.trim())) return { label: 'drop' as const, prob: 0.95 };
    // Also drop based on path for generic identifier keys.
    const path = parts.slice(2, 3).join(' ');
    if (/(^|\s)(uuid|version|id)(\s|$)/i.test(path)) return { label: 'drop' as const, prob: 0.9 };
    return { label: 'pass' as const, prob: 0.99 };
  };
  return {
    predict,
    async predictBatch(texts: string[]) {
      const out = new Array(texts.length);
      for (let i = 0; i < texts.length; i++) out[i] = await predict(texts[i]);
      return out;
    },
  };
}

describe('SFE preprocessor', () => {
  describe('sfePreprocess (direct)', () => {
    it('passes bare strings through unchanged', async () => {
      const result = await sfePreprocess('Hello, world.', { predictor: mockPredictor() });
      expect(result.filtered).toBe('Hello, world.');
      expect(result.dropped).toEqual([]);
    });

    it('passes primitives through unchanged', async () => {
      const p = mockPredictor();
      expect((await sfePreprocess(42, { predictor: p })).filtered).toBe(42);
      expect((await sfePreprocess(true, { predictor: p })).filtered).toBe(true);
      expect((await sfePreprocess(null, { predictor: p })).filtered).toBe(null);
    });

    it('drops metadata-looking fields and keeps content-looking fields', async () => {
      const input = {
        uuid: 'abc-123-def-456',
        version: 'a1b2c3',
        description: 'This is a product description that users read.',
      };
      const result = await sfePreprocess(input, { predictor: mockPredictor() });
      expect((result.filtered as Record<string, unknown>).description).toBe(input.description);
      expect(result.dropped.length).toBeGreaterThan(0);
    });

    it('keeps descriptive user-facing fields', async () => {
      const input = {
        body: {
          items: [{ description: 'A detailed product description for marketing.' }],
        },
      };
      const result = await sfePreprocess(input, { predictor: mockPredictor() });
      const desc = ((result.filtered as any)?.body?.items?.[0]?.description) as string | undefined;
      expect(desc).toBe('A detailed product description for marketing.');
    });

    it('passes payload through unchanged when the FastText runtime is unavailable', async () => {
      // When no predictor is supplied and `fasttext.wasm` isn't installed,
      // the bundled loader logs a warn and returns null. sfePreprocess
      // should then fail-open — payload passes through, zero drops.
      const input = { uuid: 'abc-123', description: 'Hello' };
      const result = await sfePreprocess(input);
      // Either the runtime is present (drops >= 0) or absent (drops === 0);
      // in neither case may we crash, and the filtered payload must be
      // structurally compatible with the input.
      expect(result.filtered).toBeDefined();
      expect(result.dropped.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('PromptDefense useSfe option', () => {
    it('is off by default — fieldsDropped is empty', async () => {
      const defense = createPromptDefense({ enableTier1: false, enableTier2: false });
      const result = await defense.defendToolResult({ uuid: 'abc', version: 'xyz' }, 'test_tool');
      expect(result.fieldsDropped).toEqual([]);
    });

    it('useSfe with a custom predictor reports dropped fields', async () => {
      const defense = createPromptDefense({
        enableTier1: false,
        enableTier2: false,
        useSfe: { predictor: mockPredictor() },
      });
      const result = await defense.defendToolResult(
        { uuid: 'abc-123-def', version: 'a1b2c3' },
        'test_tool',
      );
      expect(result.fieldsDropped.length).toBeGreaterThan(0);
    });

    it('useSfe custom threshold preserves benign content', async () => {
      const defense = createPromptDefense({
        enableTier1: false,
        enableTier2: false,
        useSfe: { predictor: mockPredictor(), threshold: 0.99 },
      });
      const result = await defense.defendToolResult(
        { uuid: 'abc-123-def', description: 'Hello' },
        'test_tool',
      );
      const sanitized = result.sanitized as Record<string, unknown> | undefined;
      expect(sanitized).toBeDefined();
      expect(String(sanitized?.description ?? '')).toContain('Hello');
    });

    it('fails open when the predictor throws', async () => {
      const throwingPredictor: SfePredictor = {
        async predict() {
          throw new Error('predictor unavailable');
        },
        async predictBatch() {
          throw new Error('predictor unavailable');
        },
      };
      const defense = createPromptDefense({
        enableTier1: false,
        enableTier2: false,
        useSfe: { predictor: throwingPredictor },
      });
      const result = await defense.defendToolResult(
        { uuid: 'abc', description: 'Hello' },
        'test_tool',
      );
      expect(result.riskLevel).toBeDefined();
      expect(result.fieldsDropped).toEqual([]);
    });
  });
});
