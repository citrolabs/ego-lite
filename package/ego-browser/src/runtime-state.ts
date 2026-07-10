/**
 * Mutable state shared by the CDP runtime and the wider helper surface.
 *
 * Keeping the transport-facing fields in this dependency-free module prevents
 * state.ts and browser-runtime.ts from importing each other. state.ts augments
 * this same object with filesystem, platform, and test hooks.
 */
export const runtimeState = {
  cdpOverride: null,
  now: () => Date.now(),
  sessionId: null,
  sessionTargetId: null,
  sessionAt: 0,
  sessionInflight: null,
  preferredTargetId: null,
  defaultTimeout: 10000,
  // Last observed Network domain state on the default session (tracked in cdp()).
  networkDomainEnabled: false,
};
