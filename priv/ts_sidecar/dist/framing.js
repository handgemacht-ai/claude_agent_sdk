/**
 * Newline-delimited JSON framing for stdin/stdout.
 *
 * Stdin: read chunks, split on `\n`, yield decoded JSON objects.
 * Stdout: serialize JSON and append `\n`. Single-writer guaranteed by
 * main.ts — every write goes through `send()` here.
 */
export async function* readFrames(stream) {
    stream.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of stream) {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, "");
            buffer = buffer.slice(idx + 1);
            if (!line.trim())
                continue;
            try {
                const value = JSON.parse(line);
                yield { raw: line, value };
            }
            catch (err) {
                // Malformed frame — emit to stderr (human log channel) and drop
                process.stderr.write(`sidecar: failed to decode frame: ${err.message} line=${JSON.stringify(line)}\n`);
            }
        }
    }
}
export function send(out, frame) {
    out.write(JSON.stringify(frame) + "\n");
}
//# sourceMappingURL=framing.js.map