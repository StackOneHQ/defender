import { describe, it, expect } from 'vitest';
import { createTier2Classifier } from '../src/classifiers/tier2-classifier';

describe('#Tier2Classifier', () => {
	describe('.isReady', () => {
		it('returns false before warmup', () => {
			const classifier = createTier2Classifier();
			expect(classifier.isReady()).toBe(false);
		});
	});

	describe('.classify', () => {
		it('skips classification when text is very short', async () => {
			const classifier = createTier2Classifier();
			const result = await classifier.classify('hi');
			expect(result.skipped).toBe(true);
			expect(result.skipReason).toContain('too short');
		});

		// ONNX model loading too slow for CI shared runners
		it.skipIf(!!process.env.CI)('auto-loads and classifies when model files exist', async () => {
			const classifier = createTier2Classifier();
			const result = await classifier.classify('This is a test sentence for classification.');
			expect(result.skipped).toBe(false);
			expect(result.score).toBeGreaterThanOrEqual(0);
			expect(result.score).toBeLessThanOrEqual(1);
		}, 60000);
	});

	describe('.getRiskLevel', () => {
		it('returns high for scores above the high threshold', () => {
			const classifier = createTier2Classifier();
			expect(classifier.getRiskLevel(0.9)).toBe('high');
		});

		it('returns medium for scores above the medium threshold', () => {
			const classifier = createTier2Classifier();
			expect(classifier.getRiskLevel(0.6)).toBe('medium');
		});

		it('returns low for scores below the medium threshold', () => {
			const classifier = createTier2Classifier();
			expect(classifier.getRiskLevel(0.3)).toBe('low');
		});
	});

	describe('.getConfig', () => {
		it('returns the configured highRiskThreshold', () => {
			const classifier = createTier2Classifier();
			expect(classifier.getConfig().highRiskThreshold).toBe(0.8);
		});

		it('returns the configured mediumRiskThreshold', () => {
			const classifier = createTier2Classifier();
			expect(classifier.getConfig().mediumRiskThreshold).toBe(0.5);
		});
	});
});

describe('#Tier2Classifier integration with ToolResultSanitizer', () => {
	it('sanitizer returns a sanitized result', async () => {
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({ useTier1Classification: true });
		const result = sanitizer.sanitize(
			{ name: 'Test document', content: 'Hello world' },
			{ toolName: 'test_tool' },
		);
		expect(result.sanitized).toBeDefined();
	});

	it('sanitizer returns metadata', async () => {
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({ useTier1Classification: true });
		const result = sanitizer.sanitize(
			{ name: 'Test document', content: 'Hello world' },
			{ toolName: 'test_tool' },
		);
		expect(result.metadata).toBeDefined();
	});
});
