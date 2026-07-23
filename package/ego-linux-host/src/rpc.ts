/**
 * Newline-delimited JSON (NDJSON) RPC for ego-linux-hostd ↔ CLI.
 *
 * Requests:  { id, method, params? }
 * Responses: { id, result? } | { id, error: { code, message } }
 * Events:    { event, params? }
 */

export type RpcRequest = { id: number; method: string; params?: any };
export type RpcResponse = {
  id: number;
  result?: any;
  error?: { code: string; message: string };
};
export type RpcEvent = { event: string; params?: any };
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

/** Encode a message as one NDJSON line (includes trailing newline). */
export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

export function encodeRequest(req: RpcRequest): string {
  return encodeLine(req);
}

export function encodeResponse(res: RpcResponse): string {
  return encodeLine(res);
}

export function encodeEvent(ev: RpcEvent): string {
  return encodeLine(ev);
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.id === "number" &&
    typeof m.method === "string" &&
    !("event" in m)
  );
}

export function isRpcResponse(msg: unknown): msg is RpcResponse {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.id === "number" &&
    !("method" in m) &&
    !("event" in m) &&
    ("result" in m || "error" in m)
  );
}

export function isRpcEvent(msg: unknown): msg is RpcEvent {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return typeof m.event === "string" && !("method" in m);
}

/**
 * Parse one NDJSON line (without trailing newline).
 * Throws on empty/invalid JSON.
 */
export function decodeLine(line: string): RpcMessage {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) {
    throw new Error("empty RPC line");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `invalid RPC JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RPC message must be a JSON object");
  }
  if (isRpcRequest(parsed)) return parsed;
  if (isRpcEvent(parsed)) return parsed;
  if (isRpcResponse(parsed)) return parsed;
  // Best-effort: treat id+method as request even if shape is odd
  const m = parsed as Record<string, unknown>;
  if (typeof m.id === "number" && typeof m.method === "string") {
    return parsed as RpcRequest;
  }
  if (typeof m.event === "string") {
    return parsed as RpcEvent;
  }
  if (typeof m.id === "number") {
    return parsed as RpcResponse;
  }
  throw new Error("unrecognized RPC message shape");
}

/**
 * Incremental buffer that splits socket chunks into complete lines.
 * Empty lines are skipped.
 */
export class LineBuffer {
  private buffer = "";

  push(data: string | Buffer): string[] {
    this.buffer += typeof data === "string" ? data : data.toString("utf8");
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Leftover bytes without a trailing newline (for diagnostics). */
  pending(): string {
    return this.buffer;
  }

  clear(): void {
    this.buffer = "";
  }
}
