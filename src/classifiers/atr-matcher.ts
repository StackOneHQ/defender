/**
 * Opt-in ATR rule pack (Agent Threat Rules, MIT). The rules are generated from a pinned release by
 * scripts/build-atr-pack.mjs; atr-pack.json records the version. Detect-only: a match is reported in
 * `atrMatches` and never changes the risk level or the block decision.
 *
 * Each pattern lists words of which every match contains one. One Aho-Corasick pass over the lowercased
 * text finds those words, and only patterns whose words are present (or that list none) run.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AtrPack {
	version: string;
	rules: Array<{
		id: string;
		logic: "any" | "all";
		patterns: Array<{ source: string; words: string[] | null; nonAscii?: boolean }>;
	}>;
}

interface Matcher {
	rules: Array<{ id: string; logic: "any" | "all"; patterns: number[] }>;
	regexes: RegExp[];
	/** Patterns that list no words: always run (the `nonAscii` ones only on non-ASCII text). */
	always: number[];
	/** Patterns that only match text with a non-ASCII character. */
	nonAscii: Uint8Array;
	/** Word id → patterns that list it. */
	byWord: number[][];
	/** Aho-Corasick: goto per node, failure links, word ids ending at each node (failure chain merged). */
	next: Array<Map<number, number>>;
	fail: number[];
	out: number[][];
	/** Dense transitions for ASCII: `ascii[node * width + column[c]]`, column 0 for characters in no word. */
	column: Uint8Array;
	width: number;
	ascii: Uint16Array | Int32Array;
	/** Pattern → its rule. */
	ruleOf: number[];
}

let matcher: Matcher | null = null;
const NON_ASCII = /[^\x00-\x7f]/;

function build(pack: AtrPack): Matcher {
	const regexes: RegExp[] = [];
	const ruleOf: number[] = [];
	const wordId = new Map<string, number>();
	const byWord: number[][] = [];
	const always: number[] = [];
	const nonAscii: number[] = [];
	const rules = pack.rules.map((r, ri) => ({
		id: r.id,
		logic: r.logic,
		patterns: r.patterns.map((p) => {
			const pi = regexes.push(new RegExp(p.source, "i")) - 1;
			ruleOf.push(ri);
			if (!p.words) always.push(pi);
			if (p.nonAscii) nonAscii.push(pi);
			for (const w of p.words ?? []) {
				let id = wordId.get(w);
				if (id === undefined) {
					id = byWord.push([]) - 1;
					wordId.set(w, id);
				}
				byWord[id].push(pi);
			}
			return pi;
		}),
	}));

	const next: Array<Map<number, number>> = [new Map()];
	const out: number[][] = [[]];
	for (const [w, id] of wordId) {
		let node = 0;
		for (let i = 0; i < w.length; i++) {
			const c = w.charCodeAt(i);
			let to = next[node].get(c);
			if (to === undefined) {
				to = next.push(new Map()) - 1;
				out.push([]);
				next[node].set(c, to);
			}
			node = to;
		}
		out[node].push(id);
	}
	const fail = new Array<number>(next.length).fill(0);
	const queue = [...next[0].values()];
	for (let q = 0; q < queue.length; q++) {
		const node = queue[q];
		for (const [c, to] of next[node]) {
			let f = fail[node];
			while (f && !next[f].has(c)) f = fail[f];
			const t = next[f].get(c);
			fail[to] = t !== undefined && t !== to ? t : 0;
			out[to] = out[to].concat(out[fail[to]]);
			queue.push(to);
		}
	}
	// A character in no word sends every node back to the root, so only word characters get a column.
	const column = new Uint8Array(128);
	let width = 1;
	for (const node of next) for (const c of node.keys()) if (c < 128 && !column[c]) column[c] = width++;
	const ascii = next.length < 65536 ? new Uint16Array(next.length * width) : new Int32Array(next.length * width);
	for (const node of [0, ...queue]) {
		for (let c = 0; c < 128; c++) {
			if (!column[c]) continue;
			const to = next[node].get(c);
			ascii[node * width + column[c]] = to ?? (node === 0 ? 0 : ascii[fail[node] * width + column[c]]);
		}
	}
	const nonAsciiMask = new Uint8Array(regexes.length);
	for (const p of nonAscii) nonAsciiMask[p] = 1;
	return { rules, regexes, always, nonAscii: nonAsciiMask, byWord, next, fail, out, column, width, ascii, ruleOf };
}

/** The pack sits next to the bundle in dist/, and next to this file in src/. */
function load(): Matcher {
	if (matcher) return matcher;
	let baseDir: string;
	try {
		baseDir = dirname(fileURLToPath(import.meta.url));
	} catch {
		baseDir = __dirname;
	}
	matcher = build(JSON.parse(readFileSync(resolve(baseDir, "atr-pack.json"), "utf8")) as AtrPack);
	return matcher;
}

/** ATR rule ids that match `text`. */
export function matchAtrRules(text: string): string[] {
	const m = load();
	const lower = text.toLowerCase();
	const isAscii = !NON_ASCII.test(text);
	const candidates = new Set<number>(isAscii ? m.always.filter((p) => !m.nonAscii[p]) : m.always);
	const seen = new Set<number>();
	let node = 0;
	for (let i = 0; i < lower.length; i++) {
		const c = lower.charCodeAt(i);
		if (c < 128) node = m.ascii[node * m.width + m.column[c]];
		else {
			while (node && !m.next[node].has(c)) node = m.fail[node];
			node = m.next[node].get(c) ?? 0;
		}
		for (const w of m.out[node]) {
			if (seen.has(w)) continue;
			seen.add(w);
			for (const p of m.byWord[w]) candidates.add(p);
		}
	}
	const rules = [...new Set([...candidates].map((p) => m.ruleOf[p]))].sort((a, b) => a - b);
	const ids: string[] = [];
	for (const ri of rules) {
		const rule = m.rules[ri];
		const hit = (p: number) => candidates.has(p) && !(isAscii && m.nonAscii[p]) && m.regexes[p].test(text);
		if (rule.logic === "all" ? rule.patterns.every(hit) : rule.patterns.some(hit)) ids.push(rule.id);
	}
	return ids;
}
