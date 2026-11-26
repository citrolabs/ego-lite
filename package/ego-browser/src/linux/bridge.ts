import type { Readable, Writable } from "node:stream";

export type CdpCall = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  timeoutMs?: number,
) => Promise<any>;

/** Browser-level CDP over pipes owned by the launcher; no listening TCP port. */
export class LinuxBridge {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = "";
  private closed = false;
  onEvent: (event: any) => void = () => {};

  constructor(
    private input: Writable,
    output: Readable,
    private timeoutMs = 15_000,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          this.close(new Error("Invalid CDP response"));
          return;
        }
        if (message.id) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error)
            request.reject(
              Object.assign(new Error(message.error.message), {
                code: message.error.code,
              }),
            );
          else request.resolve(message.result ?? {});
        } else this.onEvent(message);
      }
      if (this.buffer.length > 32 * 1024 * 1024)
        this.close(new Error("CDP response too large"));
    });
    output.on("end", () => this.close());
    output.on("error", (error) => this.close(error));
    input.on("error", (error) => this.close(error));
  }

  call: CdpCall = (
    method,
    params = {},
    sessionId,
    timeoutMs = this.timeoutMs,
  ) => {
    if (this.closed) return Promise.reject(new Error("Chrome pipe is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0",
        (error) => {
          if (error) this.close(error);
        },
      );
    });
  };

  close(error = new Error("Chrome pipe closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.input.destroy();
  }
}
