import { describe, it, expect, beforeEach } from 'vitest';
import {
	Tier2Classifier,
	createTier2Classifier,
} from '../src/classifiers/tier2-classifier';

describe('#Tier2Classifier', () => {
	let classifier: Tier2Classifier;

	beforeEach(() => {
		classifier = createTier2Classifier();
	});

	describe('.isReady', () => {
		it('returns false before warmup', () => {
			expect(classifier.isReady()).toBe(false);
		});
	});

	describe('.classify', () => {
		it('skips classification when text is very short', async () => {
			const result = await classifier.classify('hi');
			expect(result.skipped).toBe(true);
			expect(result.skipReason).toContain('too short');
		});

		// ONNX model loading too slow for CI shared runners
		it.skipIf(!!process.env.CI)('auto-loads and classifies when model files exist', async () => {
			const result = await classifier.classify('This is a test sentence for classification.');
			expect(result.skipped).toBe(false);
			expect(result.score).toBeGreaterThanOrEqual(0);
			expect(result.score).toBeLessThanOrEqual(1);
		}, 60000);
	});

	describe('.getRiskLevel', () => {
		it('returns correct risk levels for given scores', () => {
			expect(classifier.getRiskLevel(0.9)).toBe('high');
			expect(classifier.getRiskLevel(0.6)).toBe('medium');
			expect(classifier.getRiskLevel(0.3)).toBe('low');
		});
	});

	describe('.getConfig', () => {
		it('returns the current configuration', () => {
			const config = classifier.getConfig();
			expect(config.highRiskThreshold).toBe(0.8);
			expect(config.mediumRiskThreshold).toBe(0.5);
		});
	});
});

describe('#Tier2Classifier integration with ToolResultSanitizer', () => {
	it('initialises tier2 classifier when useTier2Classification is true', async () => {
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({ useTier2Classification: true });
		// not ready until warmup() is called, but classifier is initialized
		expect(sanitizer.isTier2Ready()).toBe(false);
	});

	it('exposes async sanitize method without tier2', async () => {
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({
			useTier1Classification: true,
			useTier2Classification: false,
		});
		const result = await sanitizer.sanitizeAsync(
			{ name: 'Test document', content: 'Hello world' },
			{ toolName: 'test_tool' },
		);
		expect(result.sanitized).toBeDefined();
		expect(result.metadata).toBeDefined();
	});
});
