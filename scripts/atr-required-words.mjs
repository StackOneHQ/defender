// What an ATR pattern needs in a text before it can match; used by build-atr-pack.mjs and its tests.
// Both checks answer only when sure, so a matcher that skips on them never misses a match.

const OTHER = { t: "other" };
const ZERO = { t: "zero" };

/** A small parser for the regex syntax ATR uses, enough for the two checks below. */
function parse(source) {
	let i = 0;
	const peek = () => source[i];
	const hex = (n) => (new RegExp(`^[0-9a-fA-F]{${n}}`).test(source.slice(i)) ? Number.parseInt(source.slice(i, (i += n)), 16) : -1);
	function alt() {
		const branches = [seq()];
		while (peek() === "|") {
			i++;
			branches.push(seq());
		}
		return { t: "alt", branches };
	}
	function seq() {
		const items = [];
		while (i < source.length && peek() !== "|" && peek() !== ")") items.push(quantified());
		return items;
	}
	function quantified() {
		const node = atom();
		const q = peek();
		let min;
		let max;
		if (q === "*" || q === "+" || q === "?") {
			i++;
			min = q === "+" ? 1 : 0;
			max = q === "?" ? 1 : Number.POSITIVE_INFINITY;
		} else if (q === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i))) {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
			i += m[0].length;
			min = Number(m[1]);
			max = m[2] ? (m[3] ? Number(m[3]) : Number.POSITIVE_INFINITY) : min;
		} else return node;
		if (peek() === "?") i++;
		return { t: "quant", node, min, max };
	}
	// An escaped character as a code unit, or -1 for a class escape (\d, \s, \w...) or anything unmodelled.
	function escaped() {
		const e = source[i++];
		if (e === "u") return hex(4);
		if (e === "x") return hex(2);
		if (/[dDwWsSbBpPnrtfv0-9ck]/.test(e)) return -1;
		return e.charCodeAt(0);
	}
	function atom() {
		const c = source[i++];
		if (c === "(") {
			let look = false;
			if (source.startsWith("?:", i)) i += 2;
			else if (/^\?<?[=!]/.test(source.slice(i))) {
				look = true;
				i += source[i + 1] === "<" ? 3 : 2;
			} else if (source.startsWith("?<", i)) i = source.indexOf(">", i) + 1;
			const inner = alt();
			if (source[i++] !== ")") throw new Error("unbalanced group");
			return look ? ZERO : inner;
		}
		if (c === "[") return charClass();
		if (c === "\\") {
			if ("bB".includes(peek())) {
				i++;
				return ZERO;
			}
			if (peek() === "k") {
				i = source.indexOf(">", i) + 1;
				return OTHER;
			}
			const code = escaped();
			return code < 0 ? OTHER : { t: "char", ch: String.fromCharCode(code) };
		}
		if (c === "^" || c === "$") return ZERO;
		if (c === ".") return OTHER;
		return { t: "char", ch: c };
	}
	// The code ranges a class matches, or OTHER when it holds something we don't model (negation, \w...).
	function charClass() {
		const negated = peek() === "^";
		if (negated) i++;
		const ranges = [];
		let modelled = !negated;
		let first = true;
		const one = () => (source[i] === "\\" ? (i++, escaped()) : source.charCodeAt(i++));
		while (i < source.length && (peek() !== "]" || first)) {
			first = false;
			const lo = one();
			let hi = lo;
			if (peek() === "-" && source[i + 1] !== "]") {
				i++;
				hi = one();
			}
			if (lo < 0 || hi < 0) modelled = false;
			else ranges.push([lo, hi]);
		}
		i++;
		return modelled ? { t: "class", ranges } : OTHER;
	}
	const top = alt();
	if (i !== source.length) throw new Error("trailing input");
	return top;
}

/**
 * Lowercase words of 3+ characters, one of which every match of `source` contains, or null when there
 * is no such set. Lets the matcher skip a pattern whose words are all absent from the text.
 */
export function requiredWords(source) {
	// Short words match too often to filter anything; two non-ASCII characters (a CJK word) are enough.
	const long = (w) => w.length >= 3 || (w.length === 2 && /[^\x00-\x7f]/.test(w));
	const asWords = (r) => r.req ?? (r.lit !== undefined && long(r.lit) ? [r.lit] : null);
	// A character joins a word when lowercasing it is safe under the `i` flag: ASCII letters, and
	// non-space characters without case (digits, punctuation, CJK, Arabic...).
	const litOf = (ch) => {
		if (/[A-Za-z]/.test(ch)) return ch.toLowerCase();
		return /\S/.test(ch) && ch.toLowerCase() === ch.toUpperCase() ? ch : null;
	};
	// → { lit?: the exact text the node always matches, req: words | null }
	function walk(n) {
		if (n.t === "char") {
			const lit = litOf(n.ch);
			return lit === null ? { req: null } : { lit, req: null };
		}
		if (n.t === "alt") {
			const parts = n.branches.map(seqWalk);
			if (parts.length === 1) return parts[0];
			const sets = parts.map(asWords);
			return { req: sets.some((s) => !s) ? null : [...new Set(sets.flat())] };
		}
		if (n.t === "quant") {
			if (n.min === 0) return { req: null };
			const inner = walk(n.node);
			return n.min === 1 && n.max === 1 ? inner : { req: asWords(inner) };
		}
		return { req: null };
	}
	function seqWalk(items) {
		const cands = [];
		let run = "";
		let exact = "";
		let pure = true;
		const flush = () => {
			if (long(run)) cands.push([run]);
			run = "";
		};
		for (const item of items) {
			if (item.t === "zero") continue;
			const r = walk(item);
			if (r.lit !== undefined) {
				run += r.lit;
				exact += r.lit;
				continue;
			}
			pure = false;
			flush();
			if (r.req) cands.push(r.req);
		}
		flush();
		const best = cands
			.filter((c) => c.every(long))
			.sort((a, b) => Math.min(...b.map((w) => w.length)) - Math.min(...a.map((w) => w.length)) || a.length - b.length)[0];
		return pure ? { lit: exact, req: best ?? null } : { req: best ?? null };
	}
	try {
		return asWords(walk(parse(source)));
	} catch {
		return null;
	}
}

/**
 * True when every match of `source` contains a non-ASCII character, so the pattern can't match ASCII
 * text: without the `u` flag (and with Python's re.A), `i` never maps a non-ASCII character to ASCII.
 */
export function needsNonAscii(source) {
	function walk(n) {
		if (n.t === "char") return n.ch.charCodeAt(0) > 0x7f;
		if (n.t === "class") return n.ranges.length > 0 && n.ranges.every(([lo]) => lo > 0x7f);
		if (n.t === "alt") return n.branches.every((items) => items.some(walk));
		if (n.t === "quant") return n.min >= 1 && walk(n.node);
		return false;
	}
	try {
		return walk(parse(source));
	} catch {
		return false;
	}
}
