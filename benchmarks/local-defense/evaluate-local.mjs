// Run against the published @stackone/defender package installed beside this file.
import { createPromptDefense } from '@stackone/defender';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node evaluate-local.mjs INPUT.jsonl OUTPUT.json');
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('@stackone/defender/package.json'));
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
if (pkg.version !== '0.9.4') throw new Error('This evaluation is pinned to Defender 0.9.4');
const config = { enableTier1: true, enableTier2: true, requireTier2: true, blockHighRisk: true, enableTier3: false, useSfe: false, sanitizeContent: true };
const defense = createPromptDefense(config);
await defense.warmupTier2();
const bytes = readFileSync(input);
const rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
const groups = {};
let degraded = 0;
let skipped = 0;
const skipReasons = {};
let count = 0;
for (const row of rows) {
  if (typeof row.text !== 'string' || ![0, 1].includes(row.label)) throw new Error('Invalid dataset row');
  const result = await defense.defendToolResult({ body: row.text }, 'benchmark_tool');
  const expectedSkip = ['All strings skipped by classifier: Text below minTextLength', 'All strings skipped by classifier: No classifiable sentences'].includes(result.tier2SkipReason);
  if (result.tier2Available === false || (!Number.isFinite(result.tier2Score) && !expectedSkip)) throw new Error(`Unexpected Tier 2 failure at ${row.id}: ${result.tier2SkipReason}`);
  if (result.tier3 !== undefined) throw new Error('Tier 3 unexpectedly ran');
  if (result.coverageDegraded) degraded++;
  if (result.tier2SkipReason) { skipped++; skipReasons[result.tier2SkipReason] = (skipReasons[result.tier2SkipReason] ?? 0) + 1; }
  const key = row.label === 1 ? (result.allowed ? 'fn' : 'tp') : (result.allowed ? 'tn' : 'fp');
  counts[key]++;
  groups[row.group] ??= { tp: 0, fp: 0, tn: 0, fn: 0 };
  groups[row.group][key]++;
  if (++count % 1000 === 0) console.error(`Processed ${count}/${rows.length}`);
}
function metrics(c) {
  return { ...c, precision: c.tp / (c.tp + c.fp), recall: c.tp / (c.tp + c.fn), f1: 2*c.tp / (2*c.tp+c.fp+c.fn), falsePositiveRate: c.fp / (c.fp+c.tn) };
}
const report = {
  package: pkg.name, version: pkg.version, runtime: process.version,
  onnxruntime: require('onnxruntime-node/package.json').version,
  transformers: JSON.parse(readFileSync(join(dirname(require.resolve('@huggingface/transformers')), '..', 'package.json'), 'utf8')).version,
  datasetSha256: createHash('sha256').update(bytes).digest('hex'),
  samples: rows.length, config, toolName: 'benchmark_tool', inputShape: '{ body: text }',
  decision: '!result.allowed', threshold: 0.52, multihead: false,
  coverageDegraded: degraded, tier2Skipped: skipped, skipReasons,
  results: metrics(counts), groups,
};
writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report.results));
