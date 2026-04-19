/**
 * Newline-delimited JSON framing for stdin/stdout.
 *
 * Stdin: read chunks, split on `\n`, yield decoded JSON objects.
 * Stdout: serialize JSON and append `\n`. Single-writer guaranteed by
 * main.ts — every write goes through `send()` here.
 */
import type { Writable, Readable } from "node:stream";
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [k: string]: JsonValue;
};
export interface InboundFrame {
    raw: string;
    value: Record<string, unknown>;
}
export declare function readFrames(stream: Readable): AsyncIterable<InboundFrame>;
export declare function send(out: Writable, frame: Record<string, unknown>): void;
