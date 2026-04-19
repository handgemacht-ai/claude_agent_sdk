#!/usr/bin/env node
/**
 * Sidecar main loop.
 *
 * One Node process, many logical sessions. Reads JSON-RPC frames from
 * stdin, dispatches requests by method, routes responses to the
 * outbound RPC client, writes notifications and responses to stdout.
 * Every session operation carries a `sessionId` — the Elixir side
 * owns that identifier; the sidecar stores session handles in
 * `sessions: Map<sessionId, SessionEnvelope>`.
 */
export {};
