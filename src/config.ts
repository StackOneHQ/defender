/**
 * Default configuration for the Prompt Defense Framework
 */

import type {
    PromptDefenseConfig,
    RiskyFieldConfig,
    ToolSanitizationRule,
    TraversalConfig,
} from './types';

/**
 * Default risky field configuration
 */
export const DEFAULT_RISKY_FIELDS: RiskyFieldConfig = {
    fieldNames: [
        'name',
        'description',
        'content',
        'title',
        'notes',
        'summary',
        'bio',
        'body',
        'text',
        'message',
        'comment',
        'subject',
    ],
    fieldPatterns: [
        /_name$/,
        /_description$/,
        /_content$/,
        /_body$/,
        /_notes$/,
        /_summary$/,
        /_bio$/,
        /_text$/,
        /_message$/,
        /_title$/,
    ],
    toolOverrides: {
        // Document tools - focus on content fields
        'unified_documents_*': ['name', 'description', 'content', 'title'],
        'documents_*': ['name', 'description', 'content', 'title'],

        // HRIS tools - employee data
        'unified_hris_*': ['name', 'notes', 'bio', 'description'],
        'hris_*': ['name', 'notes', 'bio', 'description'],

        // ATS tools - candidate data
        'unified_ats_*': ['name', 'notes', 'description', 'summary'],
        'ats_*': ['name', 'notes', 'description', 'summary'],

        // CRM tools - customer data
        'unified_crm_*': ['name', 'description', 'notes', 'content'],
        'crm_*': ['name', 'description', 'notes', 'content'],

        // Email/messaging tools
        'gmail_*': ['subject', 'body', 'snippet', 'content'],
        'email_*': ['subject', 'body', 'snippet', 'content'],

        // GitHub tools
        'github_*': ['name', 'description', 'body', 'content', 'message', 'title'],
    },
};

/**
 * Default traversal configuration
 */
export const DEFAULT_TRAVERSAL_CONFIG: TraversalConfig = {
    maxDepth: 10,
    maxSize: 10 * 1024 * 1024, // 10MB
    largeArrayThreshold: 1000,
    skipLargeArrays: true,
};

/**
 * Default per-tool sanitization rules
 */
export const DEFAULT_TOOL_RULES: ToolSanitizationRule[] = [
    // Document tools - higher risk due to content fields
    {
        toolPattern: /^unified_documents_/,
        sanitizationLevel: 'medium',
        maxFieldLengths: {
            name: 500,
            description: 2000,
            content: 100000,
        },
        skipFields: ['id', 'url', 'size', 'created_at', 'updated_at', 'mime_type'],
        cumulativeRiskThresholds: {
            medium: 2, // Stricter for documents
            high: 1,
            patterns: 2,
        },
    },

    // HRIS tools - medium risk
    {
        toolPattern: /^unified_hris_/,
        sanitizationLevel: 'medium',
        maxFieldLengths: {
            name: 200,
            notes: 2000,
            bio: 5000,
        },
        skipFields: ['id', 'employee_id', 'created_at', 'updated_at'],
    },

    // Email tools - higher risk due to external content
    {
        toolPattern: /^gmail_|^email_/,
        sanitizationLevel: 'high',
        maxFieldLengths: {
            subject: 500,
            body: 100000,
            snippet: 1000,
        },
        skipFields: ['id', 'thread_id', 'message_id', 'date'],
        cumulativeRiskThresholds: {
            medium: 2,
            high: 1,
            patterns: 2,
        },
    },

    // GitHub tools - medium risk
    {
        toolPattern: /^github_/,
        sanitizationLevel: 'medium',
        maxFieldLengths: {
            name: 500,
            description: 5000,
            body: 100000,
            content: 100000,
        },
        skipFields: ['id', 'sha', 'url', 'html_url', 'created_at', 'updated_at'],
    },
];

/**
 * Default cumulative risk thresholds
 */
export const DEFAULT_CUMULATIVE_RISK_THRESHOLDS = {
    medium: 3, // 3+ medium-risk fields = escalate
    high: 1, // 1+ high-risk field = escalate
    patterns: 3, // 3+ suspicious patterns across fields = escalate
};

/**
 * Default Tier 2 configuration
 */
export const DEFAULT_TIER2_CONFIG = {
    enabled: false, // Disabled until implemented
    mode: 'onnx' as const,
    highRiskThreshold: 0.8,
    mediumRiskThreshold: 0.5,
    skipBelowSize: 50, // Skip Tier 2 for very short strings
};

/**
 * Complete default configuration
 */
export const DEFAULT_CONFIG: PromptDefenseConfig = {
    riskyFields: DEFAULT_RISKY_FIELDS,
    traversal: DEFAULT_TRAVERSAL_CONFIG,
    toolRules: DEFAULT_TOOL_RULES,
    cumulativeRiskThresholds: DEFAULT_CUMULATIVE_RISK_THRESHOLDS,
    tier2: DEFAULT_TIER2_CONFIG,
    blockHighRisk: false, // Start permissive, can enable later
};

/**
 * Create a custom configuration by merging with defaults
 */
export function createConfig(overrides: Partial<PromptDefenseConfig>): PromptDefenseConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        riskyFields: {
            ...DEFAULT_CONFIG.riskyFields,
            ...overrides.riskyFields,
        },
        traversal: {
            ...DEFAULT_CONFIG.traversal,
            ...overrides.traversal,
        },
        tier2: {
            ...DEFAULT_CONFIG.tier2,
            ...overrides.tier2,
        },
        cumulativeRiskThresholds: {
            ...DEFAULT_CONFIG.cumulativeRiskThresholds,
            ...overrides.cumulativeRiskThresholds,
        },
        toolRules: overrides.toolRules ?? DEFAULT_CONFIG.toolRules,
    };
}
