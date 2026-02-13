/**
 * Core types for the Prompt Defense Framework
 */

// =============================================================================
// Risk Levels
// =============================================================================

/**
 * Risk levels determine the aggressiveness of sanitization
 * - low: Annotation only (preserve all data)
 * - medium: Strip role markers + remove patterns
 * - high: All methods including encoding detection
 * - critical: Block entirely
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// =============================================================================
// Classification Types
// =============================================================================

/**
 * Result from Tier 1 pattern detection
 */
export interface PatternMatch {
  /** The pattern that matched */
  pattern: string;
  /** The matched text */
  matched: string;
  /** Position in the original string */
  position: number;
  /** Category of the pattern */
  category: PatternCategory;
  /** Severity of this pattern match */
  severity: 'low' | 'medium' | 'high';
}

/**
 * Categories of injection patterns
 */
export type PatternCategory =
  | 'role_marker'        // SYSTEM:, ASSISTANT:, etc.
  | 'instruction_override' // "ignore previous instructions"
  | 'role_assumption'    // "you are now a..."
  | 'security_bypass'    // "bypass security", "disable guardrails"
  | 'command_execution'  // "execute the following"
  | 'encoding_suspicious' // Base64/URL encoded content
  | 'structural';         // Suspicious structure (high entropy, etc.)

/**
 * Result from Tier 1 classification
 */
export interface Tier1Result {
  /** Pattern matches found */
  matches: PatternMatch[];
  /** Structural flags */
  structuralFlags: StructuralFlag[];
  /** Whether any patterns were detected */
  hasDetections: boolean;
  /** Suggested risk level based on Tier 1 alone */
  suggestedRisk: RiskLevel;
  /** Processing time in milliseconds */
  latencyMs: number;
}

/**
 * Structural analysis flags
 */
export interface StructuralFlag {
  type: 'high_entropy' | 'excessive_length' | 'suspicious_formatting' | 'nested_markers';
  details: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * Result from Tier 2 ML classification
 */
export interface Tier2Result {
  /** Risk score from 0.0 to 1.0 */
  score: number;
  /** Confidence in the score */
  confidence: number;
  /** Whether Tier 2 was skipped (short-circuit) */
  skipped: boolean;
  /** Reason for skipping if applicable */
  skipReason?: string;
  /** Processing time in milliseconds */
  latencyMs: number;
}

/**
 * Combined classification result
 */
export interface ClassificationResult {
  tier1: Tier1Result;
  tier2?: Tier2Result;
  /** Final assigned risk level */
  riskLevel: RiskLevel;
  /** Whether the content should be blocked entirely */
  shouldBlock: boolean;
  /** Total processing time */
  totalLatencyMs: number;
}

// =============================================================================
// Sanitization Types
// =============================================================================

/**
 * Boundary markers for annotating untrusted data
 */
export interface DataBoundary {
  /** Unique identifier for this boundary */
  id: string;
  /** Opening tag, e.g., [UD-{id}] */
  startTag: string;
  /** Closing tag, e.g., [/UD-{id}] */
  endTag: string;
}

/**
 * Context for sanitization operations
 */
export interface SanitizationContext {
  /** JSON path to current field, e.g., "data[0].name" */
  path: string;
  /** Current field name being processed */
  fieldName: string;
  /** Name of the tool that produced this result */
  toolName: string;
  /** Tool category/vertical, e.g., "documents", "hris", "crm" */
  vertical: string;
  /** Resource type, e.g., "files", "employees" */
  resource: string;
  /** Current risk level for this field/context */
  riskLevel: RiskLevel;
  /** Boundary to use for annotation */
  boundary?: DataBoundary;
  /** Cumulative risk tracker for fragmented injection detection */
  cumulativeRisk?: CumulativeRiskTracker;
}

/**
 * Tracks risk across multiple fields to detect fragmented attacks
 */
export interface CumulativeRiskTracker {
  /** Count of fields flagged as medium risk */
  mediumRiskCount: number;
  /** Count of fields flagged as high risk */
  highRiskCount: number;
  /** Patterns detected across all fields */
  suspiciousPatterns: string[];
  /** Total fields processed so far */
  totalFieldsProcessed: number;
  /** Thresholds for escalation */
  escalationThreshold: {
    /** Escalate to high if mediumRiskCount >= this */
    medium: number;
    /** Escalate to high if highRiskCount >= this */
    high: number;
    /** Escalate if suspiciousPatterns.length >= this */
    patterns: number;
  };
}

/**
 * Methods applied during sanitization
 */
export type SanitizationMethod =
  | 'unicode_normalization'
  | 'boundary_annotation'
  | 'role_stripping'
  | 'pattern_removal'
  | 'encoding_detection';

/**
 * Result of sanitizing a single field
 */
export interface FieldSanitizationResult {
  /** Original value */
  original: string;
  /** Sanitized value */
  sanitized: string;
  /** Methods applied */
  methodsApplied: SanitizationMethod[];
  /** Patterns that were removed/redacted */
  patternsRemoved: string[];
  /** Risk level determined for this field */
  riskLevel: RiskLevel;
}

/**
 * Result of sanitizing a complete tool result
 */
export interface SanitizationResult<T = unknown> {
  /** The sanitized data */
  sanitized: T;
  /** Metadata about the sanitization process */
  metadata: SanitizationMetadata;
}

/**
 * Metadata about sanitization for logging/observability
 */
export interface SanitizationMetadata {
  /** Fields that were sanitized */
  fieldsSanitized: string[];
  /** Methods applied per field */
  methodsByField: Record<string, SanitizationMethod[]>;
  /** Patterns removed per field */
  patternsRemovedByField: Record<string, string[]>;
  /** Final risk level for the entire result */
  overallRiskLevel: RiskLevel;
  /** Whether cumulative risk caused escalation */
  cumulativeRiskEscalated: boolean;
  /** Total processing time */
  totalLatencyMs: number;
  /** Size metrics */
  sizeMetrics: SizeMetrics;
}

/**
 * Size tracking metrics
 */
export interface SizeMetrics {
  /** Estimated bytes processed */
  estimatedBytes: number;
  /** Number of strings processed */
  stringCount: number;
  /** Number of objects traversed */
  objectCount: number;
  /** Number of arrays traversed */
  arrayCount: number;
  /** Whether size limits were hit */
  sizeLimitHit: boolean;
  /** Whether depth limits were hit */
  depthLimitHit: boolean;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for risky field detection
 */
export interface RiskyFieldConfig {
  /** Exact field names to sanitize */
  fieldNames: string[];
  /** Patterns to match field names */
  fieldPatterns: RegExp[];
  /** Tool-specific overrides (glob pattern -> field names) */
  toolOverrides?: Record<string, string[]>;
}

/**
 * Configuration for traversal limits
 */
export interface TraversalConfig {
  /** Maximum recursion depth */
  maxDepth: number;
  /** Maximum total size in bytes */
  maxSize: number;
  /** Skip sanitization for arrays larger than this */
  largeArrayThreshold: number;
  /** Whether to skip large arrays entirely */
  skipLargeArrays: boolean;
}

/**
 * Per-tool sanitization rules
 */
export interface ToolSanitizationRule {
  /** Tool name pattern (string with wildcards or RegExp) */
  toolPattern: string | RegExp;
  /** Override risky fields for this tool */
  riskyFields?: string[];
  /** Override sanitization level */
  sanitizationLevel?: RiskLevel;
  /** Maximum field lengths */
  maxFieldLengths?: Record<string, number>;
  /** Fields to never sanitize */
  skipFields?: string[];
  /** Custom cumulative risk thresholds */
  cumulativeRiskThresholds?: {
    medium: number;
    high: number;
    patterns: number;
  };
}

/**
 * Main configuration for the prompt defense framework
 */
export interface PromptDefenseConfig {
  /** Risky field configuration */
  riskyFields: RiskyFieldConfig;
  /** Traversal limits */
  traversal: TraversalConfig;
  /** Per-tool rules */
  toolRules: ToolSanitizationRule[];
  /** Default cumulative risk thresholds */
  cumulativeRiskThresholds: {
    medium: number;
    high: number;
    patterns: number;
  };
  /** Tier 2 configuration */
  tier2: {
    /** Whether Tier 2 is enabled */
    enabled: boolean;
    /** Inference mode: 'onnx' for fine-tuned MiniLM, 'mlp' for frozen embeddings + MLP head */
    mode?: 'mlp' | 'onnx';
    /** Score threshold for high risk */
    highRiskThreshold: number;
    /** Score threshold for medium risk */
    mediumRiskThreshold: number;
    /** Size threshold to skip Tier 2 (bytes) */
    skipBelowSize: number;
  };
  /** Whether to block high/critical risk by default */
  blockHighRisk: boolean;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Any value that can be sanitized
 */
export type SanitizableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizableValue[]
  | { [key: string]: SanitizableValue };

/**
 * Structure type detection result
 */
export type StructureType = 'array' | 'object' | 'wrapped' | 'primitive' | 'null';

/**
 * Logger interface for observability
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
