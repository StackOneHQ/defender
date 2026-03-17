import { describe, it, expect } from 'vitest';
import { createTier2Classifier } from '../src/classifiers/tier2-classifier';

describe('#Tier2Classifier', () => {
	describe('.isReady', () => {
		it('returns false before warmup', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act / assert
			expect(classifier.isReady()).toBe(false);
		});
	});

	describe('.classify', () => {
		it('sets skipped to true when text is very short', async () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = await classifier.classify('hi');

			// assert
			expect(actual.skipped).toBe(true);
		});

		it('sets skipReason containing "too short" when text is very short', async () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = await classifier.classify('hi');

			// assert
			expect(actual.skipReason).toContain('too short');
		});

		// ONNX model loading too slow for CI shared runners
		it.skipIf(!!process.env.CI)('sets skipped to false when model files exist', async () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = await classifier.classify('This is a test sentence for classification.');

			// assert
			expect(actual.skipped).toBe(false);
		}, 60000);

		// ONNX model loading too slow for CI shared runners
		it.skipIf(!!process.env.CI)('returns a score in [0, 1] when model files exist', async () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = await classifier.classify('This is a test sentence for classification.');

			// assert
			expect(actual.score).toBeGreaterThanOrEqual(0);
			expect(actual.score).toBeLessThanOrEqual(1);
		}, 60000);
	});

	describe('.getRiskLevel', () => {
		it('returns high for scores above the high threshold', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act / assert
			expect(classifier.getRiskLevel(0.9)).toBe('high');
		});

		it('returns medium for scores above the medium threshold', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act / assert
			expect(classifier.getRiskLevel(0.6)).toBe('medium');
		});

		it('returns low for scores below the medium threshold', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act / assert
			expect(classifier.getRiskLevel(0.3)).toBe('low');
		});
	});

	describe('.getConfig', () => {
		it('returns the configured highRiskThreshold', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = classifier.getConfig();

			// assert
			expect(actual.highRiskThreshold).toBe(0.8);
		});

		it('returns the configured mediumRiskThreshold', () => {
			// arrange
			const classifier = createTier2Classifier();

			// act
			const actual = classifier.getConfig();

			// assert
			expect(actual.mediumRiskThreshold).toBe(0.5);
		});
	});
});

describe('#Tier2Classifier integration with ToolResultSanitizer', () => {
	it('sanitizer returns a sanitized result', async () => {
		// arrange
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({ useTier1Classification: true });

		// act
		const actual = sanitizer.sanitize(
			{ name: 'Test document', content: 'Hello world' },
			{ toolName: 'test_tool' },
		);

		// assert
		expect(actual.sanitized).toBeDefined();
	});

	it('sanitizer returns metadata', async () => {
		// arrange
		const { createToolResultSanitizer } = await import('../src/core/tool-result-sanitizer');
		const sanitizer = createToolResultSanitizer({ useTier1Classification: true });

		// act
		const actual = sanitizer.sanitize(
			{ name: 'Test document', content: 'Hello world' },
			{ toolName: 'test_tool' },
		);

		// assert
		expect(actual.metadata).toBeDefined();
	});
});
