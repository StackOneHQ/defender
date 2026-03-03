import { describe, it, expect } from 'vitest';
import {
  generateDataBoundary,
  generateXMLBoundary,
  wrapWithBoundary,
  containsBoundaryPatterns,
} from '../src/utils/boundary';
import {
  isRiskyField,
  matchesWildcard,
  getToolRule,
} from '../src/utils/field-detection';
import {
  detectStructureType,
  isPaginatedResponse,
  estimateSize,
  createSizeMetrics,
} from '../src/utils/structure';
import { DEFAULT_RISKY_FIELDS, DEFAULT_TOOL_RULES } from '../src/config';

describe('Boundary utilities', () => {
  describe('generateDataBoundary', () => {
    it('should generate unique boundaries', () => {
      const b1 = generateDataBoundary();
      const b2 = generateDataBoundary();

      expect(b1.id).not.toBe(b2.id);
      expect(b1.startTag).toMatch(/^\[UD-[A-Za-z0-9_-]+\]$/);
      expect(b1.endTag).toMatch(/^\[\/UD-[A-Za-z0-9_-]+\]$/);
    });

    it('should respect custom length', () => {
      const boundary = generateDataBoundary(8);
      expect(boundary.id).toHaveLength(8);
    });
  });

  describe('generateXMLBoundary', () => {
    it('should generate XML-style boundaries', () => {
      const boundary = generateXMLBoundary();

      expect(boundary.startTag).toMatch(/^<user-data-[A-Za-z0-9_-]+>$/);
      expect(boundary.endTag).toMatch(/^<\/user-data-[A-Za-z0-9_-]+>$/);
    });
  });

  describe('wrapWithBoundary', () => {
    it('should wrap content with boundary tags', () => {
      const boundary = { id: 'test123', startTag: '[UD-test123]', endTag: '[/UD-test123]' };
      const result = wrapWithBoundary('Hello World', boundary);

      expect(result).toBe('[UD-test123]Hello World[/UD-test123]');
    });
  });

  describe('containsBoundaryPatterns', () => {
    it('should detect standard boundary patterns', () => {
      expect(containsBoundaryPatterns('[UD-abc123]test')).toBe(true);
      expect(containsBoundaryPatterns('test[/UD-xyz]')).toBe(true);
    });

    it('should detect XML boundary patterns', () => {
      expect(containsBoundaryPatterns('<user-data-abc>test')).toBe(true);
      expect(containsBoundaryPatterns('test</user-data-xyz>')).toBe(true);
    });

    it('should not detect non-boundary patterns', () => {
      expect(containsBoundaryPatterns('Hello World')).toBe(false);
      expect(containsBoundaryPatterns('[something else]')).toBe(false);
    });
  });
});

describe('Field detection utilities', () => {
  describe('isRiskyField', () => {
    it('should identify risky fields by name', () => {
      expect(isRiskyField('name', DEFAULT_RISKY_FIELDS)).toBe(true);
      expect(isRiskyField('description', DEFAULT_RISKY_FIELDS)).toBe(true);
      expect(isRiskyField('content', DEFAULT_RISKY_FIELDS)).toBe(true);
    });

    it('should identify risky fields by pattern', () => {
      expect(isRiskyField('file_name', DEFAULT_RISKY_FIELDS)).toBe(true);
      expect(isRiskyField('job_description', DEFAULT_RISKY_FIELDS)).toBe(true);
      expect(isRiskyField('email_body', DEFAULT_RISKY_FIELDS)).toBe(true);
    });

    it('should not flag non-risky fields', () => {
      expect(isRiskyField('id', DEFAULT_RISKY_FIELDS)).toBe(false);
      expect(isRiskyField('created_at', DEFAULT_RISKY_FIELDS)).toBe(false);
      expect(isRiskyField('url', DEFAULT_RISKY_FIELDS)).toBe(false);
    });

    it('should use tool-specific overrides', () => {
      expect(isRiskyField('subject', DEFAULT_RISKY_FIELDS, 'gmail_get_message')).toBe(true);
      expect(isRiskyField('snippet', DEFAULT_RISKY_FIELDS, 'gmail_get_message')).toBe(true);
    });
  });

  describe('matchesWildcard', () => {
    it('should match exact names', () => {
      expect(matchesWildcard('gmail_get_message', 'gmail_get_message')).toBe(true);
    });

    it('should match wildcard patterns', () => {
      expect(matchesWildcard('gmail_get_message', 'gmail_*')).toBe(true);
      expect(matchesWildcard('documents_list_files', 'documents_*')).toBe(true);
    });

    it('should not match non-matching patterns', () => {
      expect(matchesWildcard('github_get_repo', 'gmail_*')).toBe(false);
    });
  });

  describe('getToolRule', () => {
    it('should find matching rule', () => {
      const rule = getToolRule('gmail_get_message', DEFAULT_TOOL_RULES);

      expect(rule).toBeDefined();
      expect(rule?.sanitizationLevel).toBe('high');
    });

    it('should return undefined for unknown tools', () => {
      const rule = getToolRule('unknown_tool', DEFAULT_TOOL_RULES);

      expect(rule).toBeUndefined();
    });
  });
});

describe('Structure utilities', () => {
  describe('detectStructureType', () => {
    it('should detect arrays', () => {
      expect(detectStructureType([1, 2, 3])).toBe('array');
      expect(detectStructureType([])).toBe('array');
    });

    it('should detect plain objects', () => {
      expect(detectStructureType({ foo: 'bar' })).toBe('object');
    });

    it('should detect wrapped responses', () => {
      expect(detectStructureType({ data: [], meta: {} })).toBe('wrapped');
      expect(detectStructureType({ results: [], total: 10 })).toBe('wrapped');
      expect(detectStructureType({ items: [] })).toBe('wrapped');
    });

    it('should detect primitives', () => {
      expect(detectStructureType('string')).toBe('primitive');
      expect(detectStructureType(123)).toBe('primitive');
      expect(detectStructureType(true)).toBe('primitive');
    });

    it('should detect null/undefined', () => {
      expect(detectStructureType(null)).toBe('null');
      expect(detectStructureType(undefined)).toBe('null');
    });
  });

  describe('isPaginatedResponse', () => {
    it('should detect paginated responses', () => {
      expect(isPaginatedResponse({ data: [], next: 'cursor' })).toBe(true);
      expect(isPaginatedResponse({ results: [], total: 100 })).toBe(true);
      expect(isPaginatedResponse({ items: [], hasMore: true })).toBe(true);
    });

    it('should not detect non-paginated responses', () => {
      expect(isPaginatedResponse({ data: [] })).toBe(false); // No pagination field
      expect(isPaginatedResponse({ next: 'cursor' })).toBe(false); // No data field
      expect(isPaginatedResponse([1, 2, 3])).toBe(false);
      expect(isPaginatedResponse('string')).toBe(false);
    });
  });

  describe('estimateSize', () => {
    it('should estimate string size', () => {
      expect(estimateSize('hello')).toBe(7); // 5 + 2 quotes
    });

    it('should estimate number size', () => {
      expect(estimateSize(123)).toBe(3);
      expect(estimateSize(1.5)).toBe(3);
    });

    it('should estimate boolean size', () => {
      expect(estimateSize(true)).toBe(4);
      expect(estimateSize(false)).toBe(5);
    });

    it('should estimate null size', () => {
      expect(estimateSize(null)).toBe(4);
    });
  });

  describe('createSizeMetrics', () => {
    it('should create initial metrics', () => {
      const metrics = createSizeMetrics();

      expect(metrics.estimatedBytes).toBe(0);
      expect(metrics.stringCount).toBe(0);
      expect(metrics.objectCount).toBe(0);
      expect(metrics.arrayCount).toBe(0);
      expect(metrics.sizeLimitHit).toBe(false);
      expect(metrics.depthLimitHit).toBe(false);
    });
  });
});
