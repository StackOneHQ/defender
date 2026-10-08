/**
 * Git LFS pointer detection for bundled model files.
 *
 * Models are tracked with Git LFS; a checkout without `git lfs pull` (or without
 * git-lfs installed) leaves a ~130-byte text pointer in place of the real binary.
 * Loading that pointer as a model throws cryptic parse errors, so detect it and
 * fail with an actionable message instead.
 */
import { closeSync, openSync, readSync } from "node:fs";

const LFS_POINTER_MAGIC = "version https://git-lfs.github.com/spec/v1";

/** True if `path` begins with the Git LFS pointer header (not the real binary). */
export function isLfsPointer(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(LFS_POINTER_MAGIC.length);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return n >= LFS_POINTER_MAGIC.length && buf.toString("utf8") === LFS_POINTER_MAGIC;
	} catch {
		return false; // unreadable / other errors aren't a pointer; let the caller surface them
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Throw a clear, actionable error if `path` is an unmaterialized Git LFS pointer. */
export function assertNotLfsPointer(path: string): void {
	if (isLfsPointer(path)) {
		throw new Error(
			`model at ${path} is a Git LFS pointer, not the real file — run \`git lfs pull\` (install git-lfs first if needed)`,
		);
	}
}
