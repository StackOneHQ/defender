/**
 * Tier 3 provider registry.
 *
 * The defender package ships no Tier 3 implementations — proprietary model
 * endpoints (SageMaker, OpenAI, etc.) live in consumer code. Consumers call
 * `setDefaultTier3Provider(provider)` once at app startup; `PromptDefense`
 * picks the registered provider up when callers opt into Tier 3 via the
 * `enableTier3: true` option on `PromptDefenseOptions`.
 *
 * Note on naming: defender's runtime option is `enableTier3`. Consumers
 * driving defender from JSON config (e.g. `@stackone/core` `DefenderSettings`)
 * may surface this same toggle under a different settings key
 * (`useTier3Classification`) — that mapping is the host service's
 * responsibility; defender only sees the resolved `enableTier3` boolean.
 *
 * Module-level singleton because the defender is instantiated per-request
 * inside connect-sdk and we don't want to pipe a provider object through that
 * boundary on every call. The JSON-serializable settings flow through the
 * existing settings path; the provider object lives here.
 */
import type { Tier3Provider } from "../types";

let _defaultProvider: Tier3Provider | null = null;

/**
 * Register the process-wide default Tier 3 provider. Pass `null` to clear
 * (useful in tests). Calling again replaces any previously-set provider.
 */
export function setDefaultTier3Provider(provider: Tier3Provider | null): void {
	_defaultProvider = provider;
}

/**
 * Retrieve the currently-registered default Tier 3 provider, or `null` if
 * none has been registered.
 */
export function getDefaultTier3Provider(): Tier3Provider | null {
	return _defaultProvider;
}
