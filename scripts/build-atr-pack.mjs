// Build the opt-in ATR rule pack (src/classifiers/atr-pack.json) from a pinned agent-threat-rules release.
//
//   node scripts/build-atr-pack.mjs [rules-dir]   (default: node_modules/agent-threat-rules/rules)
//
// Keeps what ATR's own engine runs on a tool response, in the families we ship, and only regexes that
// compile in JavaScript and Python and that recheck finds safe from catastrophic backtracking.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSync } from "recheck";
import { parse } from "yaml";
import { needsNonAscii, requiredWords } from "./atr-required-words.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rulesDir = resolve(process.argv[2] ?? join(root, "node_modules/agent-threat-rules/rules"));
const version = JSON.parse(readFileSync(join(rulesDir, "../package.json"), "utf8")).version;

const FAMILIES = ["prompt-injection", "tool-poisoning", "context-exfiltration", "agent-manipulation"];
// ATR's engine: rule sources a tool_response event admits, and the fields it reads the response into.
const SOURCES = new Set(["mcp_exchange", "llm_io", "context_window"]);
const FIELDS = new Set(["tool_response", "content", "user_input", "agent_output"]);
const LEADING_FLAGS = /^\(\?[imsx]+\)/;

// Rules that matched benign tool results in toucan, holdout_prod-benign or notinject and caught fewer than
// 5 attacks 0.9.5 misses per benign hit (Modal, 2026-11-13). sfe940 was kept out of the choice.
const EXCLUDED = new Set([
	"ATR-2026-00005",
	"ATR-2026-00080",
	"ATR-2026-00021",
	"ATR-2026-00032",
	"ATR-2026-00133",
	"ATR-2026-00227",
	"ATR-2026-00237",
	"ATR-2026-00244",
	"ATR-2026-00454",
	"ATR-2026-00481",
	"ATR-2026-00493",
]);

const dropped = {
	status: 0,
	source: 0,
	noPatterns: 0,
	unicode: 0,
	jsCompile: 0,
	pyCompile: 0,
	redos: 0,
	excluded: 0,
};
const candidates = [];
for (const family of FAMILIES) {
	for (const file of readdirSync(join(rulesDir, family)).sort()) {
		if (!file.endsWith(".yaml")) continue;
		const rule = parse(readFileSync(join(rulesDir, family, file), "utf8"));
		if (["draft", "deprecated"].includes(rule.status) || rule.maturity === "deprecated") {
			dropped.status++;
			continue;
		}
		if (!SOURCES.has(rule.agent_source?.type)) {
			dropped.source++;
			continue;
		}
		const det = rule.detection ?? {};
		const conds = Array.isArray(det.conditions) ? det.conditions : [];
		const logic = det.condition === "all" ? "all" : det.condition === "any" ? "any" : null;
		const usable = conds.filter((c) => c.operator === "regex" && FIELDS.has(c.field) && typeof c.value === "string");
		// An "all" rule needs every condition; anything but any/all is an expression we don't evaluate.
		if (!logic || usable.length === 0 || (logic === "all" && usable.length !== conds.length)) {
			dropped.noPatterns++;
			continue;
		}
		const patterns = [];
		for (const c of usable) {
			const source = c.value.replace(LEADING_FLAGS, "");
			if (/\\u\{|\\p\{|[\u{10000}-\u{10ffff}]/u.test(source)) {
				dropped.unicode++;
				continue;
			}
			try {
				new RegExp(source, "i");
			} catch {
				dropped.jsCompile++;
				continue;
			}
			patterns.push(source);
		}
		if (patterns.length === 0 || (logic === "all" && patterns.length !== usable.length)) {
			dropped.noPatterns++;
			continue;
		}
		candidates.push({ id: rule.id, family, severity: rule.severity, maturity: rule.maturity, logic, patterns });
	}
}

// Python: compile every pattern as defender-py will (case-insensitive, ASCII classes like JS without `u`).
const all = [...new Set(candidates.flatMap((r) => r.patterns))];
const pyBad = new Set(
	JSON.parse(
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,re,sys\nbad=[]\nfor p in json.load(sys.stdin):\n    try: re.compile(p, re.I | re.A)\n    except re.error: bad.append(p)\nprint(json.dumps(bad))",
			],
			{ input: JSON.stringify(all) },
		).toString(),
	),
);
// recheck takes up to 10 s per pattern, so verdicts are cached between runs (not committed).
const cacheFile = join(root, "node_modules/.cache/atr-redos.json");
mkdirSync(dirname(cacheFile), { recursive: true });
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
const safe = new Map();
for (const p of all) {
	if (pyBad.has(p)) continue;
	cache[p] ??= checkSync(p, "i", { timeout: 10_000 }).status;
	safe.set(p, cache[p] === "safe");
}
writeFileSync(cacheFile, JSON.stringify(cache));

const rules = [];
for (const r of candidates) {
	if (EXCLUDED.has(r.id)) {
		dropped.excluded++;
		continue;
	}
	const ok = r.patterns.filter((p) => {
		if (pyBad.has(p)) dropped.pyCompile++;
		else if (!safe.get(p)) dropped.redos++;
		return safe.get(p);
	});
	if (ok.length === 0 || (r.logic === "all" && ok.length !== r.patterns.length)) continue;
	rules.push({
		...r,
		patterns: ok.map((source) => ({
			source,
			words: requiredWords(source),
			...(needsNonAscii(source) ? { nonAscii: true } : {}),
		})),
	});
}

// MIT: the copyright and permission notice travel with the rules.
const licenseText = readFileSync(join(rulesDir, "../LICENSE"), "utf8");
const out = { source: "agent-threat-rules", version, license: "MIT", licenseText, families: FAMILIES, rules };
writeFileSync(join(root, "src/classifiers/atr-pack.json"), `${JSON.stringify(out, null, "\t")}\n`);
const count = (f) => rules.filter((r) => r.family === f);
console.log(`ATR ${version}: ${rules.length} rules, ${rules.reduce((n, r) => n + r.patterns.length, 0)} patterns`);
for (const f of FAMILIES) console.log(`  ${f}: ${count(f).length} rules`);
console.log("dropped:", dropped);
