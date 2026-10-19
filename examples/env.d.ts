// The few Node globals the examples use, so they typecheck without @types/node.
declare const process: {
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};
