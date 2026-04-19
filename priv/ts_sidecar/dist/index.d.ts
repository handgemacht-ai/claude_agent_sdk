#!/usr/bin/env node
/**
 * Sidecar main loop.
 *
 * One Node process, many logical sessions. Each session wraps a single
 * `query()` on the SDK. Control operations (getContextUsage,
 * supportedAgents, setModel, interrupt, …) route through
 * `session.control`.
 */
export {};
