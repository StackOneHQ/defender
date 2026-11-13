// Prefilter words for an ATR pattern; used by build-atr-pack.mjs and its tests.

/**
 * Lowercase words of 3+ characters, one of which every match of `source` contains, or null when there
 * is no such set. Lets the matcher skip a pattern whose words are all absent from the text.
 */
export function requiredWords(source) {
	// Short words match too often to filter anything; two non-ASCII characters (a CJK word) are enough.
	const long = (w) => w.length >= 3 || (w.length === 2 && /[^\x00-\x7f]/.test(w));
	let i = 0;
	const peek = () => source[i];
	const OTHER = { other: true };
	const ZERO = { zero: true };
	function alt() {
		const branches = [seq()];
		while (peek() === "|") {
			i++;
			branches.push(seq());
		}
		if (branches.length === 1) return branches[0];
		const sets = branches.map((b) => b.req);
		return { req: sets.some((s) => !s) ? null : [...new Set(sets.flat())] };
	}
	function seq() {
		const cands = [];
		let run = "";
		let exact = "";
		let pure = true;
		const flush = () => {
			if (long(run)) cands.push([run]);
			run = "";
		};
		while (i < source.length && peek() !== "|" && peek() !== ")") {
			const node = quantified();
			if (node.zero) continue;
			if (node.lit !== undefined) {
				run += node.lit;
				exact += node.lit;
				continue;
			}
			pure = false;
			flush();
			if (node.req) cands.push(node.req);
		}
		flush();
		const best = cands
			.filter((c) => c.every(long))
			.sort((a, b) => Math.min(...b.map((w) => w.length)) - Math.min(...a.map((w) => w.length)) || a.length - b.length)[0];
		return pure ? { lit: exact, req: best ?? null } : { req: best ?? null };
	}
	function quantified() {
		const node = atom();
		let min = 1;
		let max = 1;
		const q = peek();
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
		if (node.zero) return node;
		if (min === 0) return OTHER;
		if (min === 1 && max === 1) return node;
		return node.req ? { req: node.req } : node.lit && long(node.lit) ? { req: [node.lit] } : OTHER;
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
		if (c === "[") {
			if (peek() === "^") i++;
			if (peek() === "]") i++;
			while (i < source.length && peek() !== "]") i += peek() === "\\" ? 2 : 1;
			i++;
			return OTHER;
		}
		if (c === "\\") {
			const e = source[i++];
			if ("bB".includes(e)) return ZERO;
			if (e === "k") {
				i = source.indexOf(">", i) + 1;
				return OTHER;
			}
			if (/[dDwWsSnrtfv0-9cxuk]/.test(e)) return OTHER;
			return literal(e);
		}
		if (c === "^" || c === "$") return ZERO;
		if (c === ".") return OTHER;
		return literal(c);
	}
	// A literal joins a word when lowercasing it is safe under the `i` flag: ASCII letters, and
	// non-space characters without case (digits, punctuation, CJK, Arabic...).
	function literal(ch) {
		if (/[A-Za-z]/.test(ch)) return { lit: ch.toLowerCase() };
		return /\S/.test(ch) && ch.toLowerCase() === ch.toUpperCase() ? { lit: ch } : OTHER;
	}
	try {
		const top = alt();
		if (i !== source.length) return null;
		return top.req ?? (top.lit && long(top.lit) ? [top.lit] : null);
	} catch {
		return null;
	}
}
