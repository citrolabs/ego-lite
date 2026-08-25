const REQUEST_TIMEOUT_MS = 15000;

// Host-internal request ids start far above the runtime's own counter (which
// starts at 1) purely as a debugging aid when reading raw traffic; the host
// and the runtime never share a websocket, so ids cannot actually collide.
const FIRST_HOST_ID = 1_000_000;

type SocketLike = {
  send(payload: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void;
};

/**
 * A minimal browser-level CDP client over the global WebSocket (Node >= 22).
 * One instance per websocket: the host uses its own connection for internal
 * calls (tab bookkeeping, snapshots) and hands a second, dedicated connection
 * to the agent runtime, so flattened session state never crosses over.
 */
export class CdpConnection {
  socket: SocketLike;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  handlers: Set<(raw: string) => void>;
  nextId: number;

  static async open(
    url: string,
    socketFactory: (url: string) => SocketLike = (u) => new WebSocket(u),
  ) {
    const socket = socketFactory(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`CDP websocket failed to open: ${url}`)),
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  constructor(socket: SocketLike) {
    this.socket = socket;
    this.pending = new Map();
    this.handlers = new Set();
    this.nextId = FIRST_HOST_ID;
    socket.addEventListener("message", (event) =>
      this.dispatch(String(event.data)),
    );
    socket.addEventListener("close", () => this.rejectAll("CDP socket closed"));
  }

  /** Subscribe to every raw message on this connection. Returns unsubscribe. */
  onMessage(handler: (raw: string) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Forward an already-serialized CDP payload verbatim. */
  sendRaw(payload: string) {
    this.socket.send(payload);
  }

  /** Send one host-internal CDP request and await its response. */
  request(
    method: string,
    params: any = {},
    sessionId: string | undefined = undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // A socket that is already closing is fine.
    }
  }

  private dispatch(raw: string) {
    for (const handler of [...this.handlers]) {
      try {
        handler(raw);
      } catch {
        // One subscriber must not break delivery to the others.
      }
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Object.hasOwn(data, "id") || !this.pending.has(data.id)) {
      return;
    }
    const entry = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (data.error) {
      entry.reject(new Error(data.error.message || JSON.stringify(data.error)));
      return;
    }
    entry.resolve(data.result ?? {});
  }

  private rejectAll(reason: string) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(new Error(reason));
    }
  }
}
