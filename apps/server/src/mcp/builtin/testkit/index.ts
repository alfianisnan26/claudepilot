/** The stand-in provider kit (providers PRD §6): `startProvider(preset, overrides)` and what goes with it. */
export { startProvider, type StandInProvider } from './provider.js';
export { PINNED_REDIRECT, PROVIDER_PRESETS, resolveOptions, type ProviderPreset } from './presets.js';
export { selfSignedCertificate } from './cert.js';
export type { ClientRecord, LoggedRequest, OAuthOptions, PreRegisteredClient, ProviderOptions, ProviderOverrides, Quirks, TokenRecord } from './types.js';
