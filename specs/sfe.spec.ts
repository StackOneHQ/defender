import { describe, it, expect } from 'vitest';
import { createPromptDefense, sfePreprocess } from '../src';

describe('SFE preprocessor', () => {
  describe('sfePreprocess (direct)', () => {
    it('passes bare strings through unchanged', async () => {
      const result = await sfePreprocess('Hello, world.');
      expect(result.filtered).toBe('Hello, world.');
      expect(result.dropped).toEqual([]);
    });

    it('passes primitives through unchanged', async () => {
      expect((await sfePreprocess(42)).filtered).toBe(42);
      expect((await sfePreprocess(true)).filtered).toBe(true);
      expect((await sfePreprocess(null)).filtered).toBe(null);
    });

    it('drops metadata-looking fields and keeps content-looking fields', async () => {
      const input = {
        uuid: 'abc-123-def-456',
        version: 'a1b2c3',
        description: 'This is a product description that users read.',
      };
      const result = await sfePreprocess(input);
      // uuid and version are identifier-looking; description is user content
      expect((result.filtered as Record<string, unknown>).description).toBe(input.description);
      // We don't assert the exact set of drops (depends on FT model),
      // but at least one of the metadata fields should go
      expect(result.dropped.length).toBeGreaterThan(0);
    });

    it('keeps descriptive user-facing fields', async () => {
      const input = {
        body: {
          items: [{ description: 'A detailed product description for marketing.' }],
        },
      };
      const result = await sfePreprocess(input);
      const desc = ((result.filtered as any)?.body?.items?.[0]?.description) as string | undefined;
      expect(desc).toBe('A detailed product description for marketing.');
    });
  });

  describe('PromptDefense useSfe option', () => {
    it('is off by default — fieldsDropped is empty', async () => {
      const defense = createPromptDefense({ enableTier1: false, enableTier2: false });
      const result = await defense.defendToolResult({ uuid: 'abc', version: 'xyz' }, 'test_tool');
      expect(result.fieldsDropped).toEqual([]);
    });

    it('useSfe=true enables preprocessing and reports dropped fields', async () => {
      const defense = createPromptDefense({ enableTier1: false, enableTier2: false, useSfe: true });
      await defense.warmupTier2();
      const result = await defense.defendToolResult(
        { uuid: 'abc-123-def', version: 'a1b2c3' },
        'test_tool',
      );
      expect(result.fieldsDropped.length).toBeGreaterThan(0);
    }, 30000);

    it('useSfe with custom threshold passes through', async () => {
      const defense = createPromptDefense({
        enableTier1: false,
        enableTier2: false,
        useSfe: { threshold: 0.99 }, // very conservative — should drop fewer
      });
      await defense.warmupTier2();
      const result = await defense.defendToolResult(
        { uuid: 'abc-123-def', description: 'Hello' },
        'test_tool',
      );
      // Conservative threshold — description definitely kept (may be wrapped
      // with sanitizer boundary tags, so assert key presence + content).
      const sanitized = result.sanitized as Record<string, unknown> | undefined;
      expect(sanitized).toBeDefined();
      expect(String(sanitized?.description ?? '')).toContain('Hello');
    }, 30000);

    it('fails open when SFE runtime cannot process value', async () => {
      // A recursive/unusual value — SFE should not crash the pipeline
      const weird: any = {};
      weird.self = weird; // circular — SFE should fail open
      const defense = createPromptDefense({ enableTier1: false, enableTier2: false, useSfe: true });
      await defense.warmupTier2();
      const result = await defense.defendToolResult(weird, 'test_tool');
      expect(result.riskLevel).toBeDefined();
      // With fail-open, fieldsDropped is empty
      expect(result.fieldsDropped).toEqual([]);
    }, 30000);
  });
});
