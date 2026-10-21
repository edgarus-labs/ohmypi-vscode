import { isWithinRoots, resolveToolPath } from "../changePaths";

/** Where tool paths resolve (`cwd`) and the roots they must lie in. */
export interface WorkspaceScope {
	cwd: string;
	roots: readonly string[];
}

const INT_MAX = 2 ** 31 - 1;

/**
 * Typed, validated access to a host tool call's arguments. Every accessor throws an `Error`
 * whose message tells the agent what to fix; `null` counts as absent.
 */
export class ToolArguments {
	readonly #values: Record<string, unknown>;
	readonly #scope: WorkspaceScope;

	constructor(values: Record<string, unknown>, scope: WorkspaceScope) {
		this.#values = values;
		this.#scope = scope;
	}

	/** A string that must be present and, unless `allowEmpty`, not blank. */
	requiredString(name: string, allowEmpty = false): string {
		if (this.#value(name) === undefined) throw new Error(`'${name}' is required`);
		const value = this.#string(name);
		if (!allowEmpty && value.trim().length === 0) throw new Error(`'${name}' must not be empty`);
		return value;
	}

	/** A string, or `undefined` when it is absent or blank. */
	optionalString(name: string): string | undefined {
		if (this.#value(name) === undefined) return undefined;
		const value = this.#string(name);
		return value.trim().length === 0 ? undefined : value;
	}

	requiredInt(name: string, min: number): number {
		const value = this.optionalInt(name, min);
		if (value === undefined) throw new Error(`'${name}' is required`);
		return value;
	}

	/** A JSON number without fraction, at least `min` and at most 2^31 - 1. */
	optionalInt(name: string, min: number): number | undefined {
		const value = this.#value(name);
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > INT_MAX) {
			throw new Error(`'${name}' must be an integer >= ${min}`);
		}
		return value;
	}

	optionalBool(name: string): boolean | undefined {
		const value = this.#value(name);
		if (value === undefined) return undefined;
		if (typeof value !== "boolean") throw new Error(`'${name}' must be true or false`);
		return value;
	}

	requiredChoice<T extends string>(name: string, allowed: readonly T[]): T {
		if (this.#value(name) === undefined) throw new Error(`'${name}' is required (one of: ${allowed.join(", ")})`);
		return this.#choice(name, allowed);
	}

	optionalChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
		return this.#value(name) === undefined ? fallback : this.#choice(name, allowed);
	}

	/** An absolute path resolved against the working directory; it must lie inside a workspace root. */
	requiredPath(name: string): string {
		return this.#inside(name, this.requiredString(name));
	}

	optionalPath(name: string): string | undefined {
		const raw = this.optionalString(name);
		return raw === undefined ? undefined : this.#inside(name, raw);
	}

	#choice<T extends string>(name: string, allowed: readonly T[]): T {
		const value = this.#string(name);
		const match = allowed.find(option => option === value);
		if (match === undefined) throw new Error(`'${name}' must be one of: ${allowed.join(", ")} (got '${value}')`);
		return match;
	}

	#inside(name: string, raw: string): string {
		const full = resolveToolPath(raw, this.#scope.cwd);
		if (full === undefined) throw new Error(`'${name}' is not a local file path: ${raw}`);
		if (!isWithinRoots(full, this.#scope.roots)) throw new Error(`'${name}' must be inside the workspace (${this.#scope.cwd}): ${full}`);
		return full;
	}

	#string(name: string): string {
		const value = this.#value(name);
		if (typeof value !== "string") throw new Error(`'${name}' must be a string`);
		return value;
	}

	#value(name: string): unknown {
		const value = Object.hasOwn(this.#values, name) ? this.#values[name] : undefined;
		return value === null ? undefined : value;
	}
}
