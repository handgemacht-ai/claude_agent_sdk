#!/usr/bin/env node
/**
 * Sidecar main loop.
 *
 * One Node process, many logical sessions. Reads JSON-RPC frames from
 * stdin, dispatches by method, writes responses and notifications to
 * stdout. Every session operation carries a `sessionId` — the Elixir
 * side owns that identifier and the sidecar stores the session handle
 * in `sessions: Map<sessionId, SessionEnvelope>`.
 */
export {};
