import { AsyncLocalStorage } from "node:async_hooks";

import { browserEgo, ensureSession } from "./browser-runtime.js";
import { invokeEgo } from "./ego-errors.js";

type SpaceScope = {
  spaceId: number;
};

export type PageExecutionContext = SpaceScope & {
  targetId: string;
  sessionId: string;
};

type NativeGateServices = {
  selectSpace(spaceId: number): unknown | Promise<unknown>;
  ensureSession(targetId: string, timeoutMs?: number): Promise<string>;
};

export type GateMode = "shared" | "exclusive";

export type WithSpaceOptions = {
  /**
   * `exclusive` (the default) runs alone. `shared` runs alongside other
   * shared work in the same task space; only switching to another space has
   * to wait for it.
   */
  mode?: GateMode;
  /** A caller that gave up while queued never selects the space. */
  signal?: AbortSignal;
};

export type WithPageOptions = WithSpaceOptions & {
  /** Budget for attaching and preparing the Page session. */
  sessionTimeoutMs?: number;
};

type PageTarget = {
  spaceId: number;
  targetId: string;
};

type GateOwnership = SpaceScope & {
  active: boolean;
};

type Lease = {
  spaceId: number;
  mode: GateMode;
  holders: number;
  /** Settles once the space is selected for this lease. */
  ready: Promise<void>;
};

type Waiter = {
  spaceId: number;
  mode: GateMode;
  signal?: AbortSignal;
  admit(lease: Lease): void;
  reject(reason: unknown): void;
  onAbort?: () => void;
};

/**
 * Orders native operations that rely on Ego Lite's process-wide selected task
 * space. The selected space cannot change while any operation that selected it
 * is still in flight: a lease on one space lasts until its last holder ends.
 *
 * Within one space, `shared` operations (navigation, waits, reads) hold the
 * lease together, so Pages load in parallel; `exclusive` operations (input,
 * lifecycle changes) hold it alone. Requests are admitted in arrival order, so
 * a waiting exclusive operation or space switch is not starved by later
 * shared work. Operations on the same Page always run one at a time.
 */
export class NativeOperationGate {
  readonly #services: NativeGateServices;
  readonly #ownership = new AsyncLocalStorage<GateOwnership>();
  #lease: Lease | null = null;
  readonly #queue: Waiter[] = [];
  readonly #pageTails = new Map<string, Promise<void>>();

  constructor(services: NativeGateServices) {
    if (!services || typeof services.selectSpace !== "function") {
      throw new TypeError("NativeOperationGate requires selectSpace");
    }
    if (typeof services.ensureSession !== "function") {
      throw new TypeError("NativeOperationGate requires ensureSession");
    }
    this.#services = services;
  }

  withSpace<T>(
    spaceId: number,
    operation: (scope: SpaceScope) => T | Promise<T>,
    options: WithSpaceOptions = {},
  ): Promise<T> {
    assertSpaceId(spaceId);
    if (typeof operation !== "function") {
      throw new TypeError("withSpace requires an operation function");
    }
    const nested = this.#nested(spaceId);
    if (nested) return nested.then(() => operation({ spaceId }));
    return this.#runInSpace(spaceId, options, () => operation({ spaceId }));
  }

  withPage<T>(
    page: PageTarget,
    operation: (context: PageExecutionContext) => T | Promise<T>,
    options: WithPageOptions = {},
  ): Promise<T> {
    if (!page || typeof page !== "object") {
      throw new TypeError("withPage requires a page target");
    }
    assertSpaceId(page.spaceId);
    if (typeof page.targetId !== "string" || page.targetId.length === 0) {
      throw new TypeError("withPage requires a non-empty targetId");
    }
    if (typeof operation !== "function") {
      throw new TypeError("withPage requires an operation function");
    }

    const inPage = async () => {
      const sessionId = await this.#services.ensureSession(
        page.targetId,
        options.sessionTimeoutMs,
      );
      return operation({
        spaceId: page.spaceId,
        targetId: page.targetId,
        sessionId,
      });
    };
    // Nested calls run inside the outer operation's lease and Page turn.
    const nested = this.#nested(page.spaceId);
    if (nested) return nested.then(inPage);

    const key = `${page.spaceId}:${page.targetId}`;
    const previous = this.#pageTails.get(key) ?? Promise.resolve();
    const result = previous.then(() =>
      this.#runInSpace(page.spaceId, options, inPage),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#pageTails.set(key, tail);
    void tail.then(() => {
      if (this.#pageTails.get(key) === tail) this.#pageTails.delete(key);
    });
    return result;
  }

  /**
   * Re-entry deliberately bypasses the queue because the outer operation owns
   * the lease. Nested callers must await same-space work in order; Promise.all
   * here would issue concurrent native requests on purpose.
   */
  #nested(spaceId: number): Promise<void> | undefined {
    const ownership = this.#ownership.getStore();
    if (!ownership?.active) return undefined;
    if (ownership.spaceId !== spaceId) {
      return Promise.reject(
        new Error(
          `cannot select space ${spaceId} while space ${ownership.spaceId} is active`,
        ),
      );
    }
    return Promise.resolve();
  }

  async #runInSpace<T>(
    spaceId: number,
    options: WithSpaceOptions,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const lease = await this.#acquire(
      spaceId,
      options.mode ?? "exclusive",
      options.signal,
    );
    try {
      await lease.ready;
      const acquired: GateOwnership = { spaceId, active: true };
      return await this.#ownership.run(acquired, async () => {
        try {
          return await operation();
        } finally {
          // AsyncLocalStorage also flows into detached child tasks. Mark this
          // lease inactive when its awaited operation ends so late work queues
          // normally instead of bypassing a released gate.
          acquired.active = false;
        }
      });
    } finally {
      this.#release(lease);
    }
  }

  #acquire(
    spaceId: number,
    mode: GateMode,
    signal: AbortSignal | undefined,
  ): Promise<Lease> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length === 0 && this.#admits(spaceId, mode)) {
      return Promise.resolve(this.#join(spaceId, mode));
    }
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = { spaceId, mode, signal, admit: resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason);
          // The aborted waiter may have been holding back compatible work.
          this.#drain();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  /** Whether a request can hold the current lease (or start a new one). */
  #admits(spaceId: number, mode: GateMode): boolean {
    const lease = this.#lease;
    if (!lease) return true;
    return (
      mode === "shared" && lease.mode === "shared" && lease.spaceId === spaceId
    );
  }

  #join(spaceId: number, mode: GateMode): Lease {
    if (!this.#lease) {
      const ready = Promise.resolve().then(() =>
        this.#services.selectSpace(spaceId),
      ) as Promise<void>;
      // Each holder awaits `ready` itself; this only keeps a failed selection
      // from also surfacing as an unhandled rejection.
      ready.catch(() => {});
      this.#lease = { spaceId, mode, holders: 0, ready };
    }
    this.#lease.holders += 1;
    return this.#lease;
  }

  #release(lease: Lease): void {
    lease.holders -= 1;
    if (lease.holders > 0) return;
    if (this.#lease === lease) this.#lease = null;
    this.#drain();
  }

  /** Admit waiters in arrival order while they fit the current lease. */
  #drain(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (!this.#admits(head.spaceId, head.mode)) return;
      this.#queue.shift();
      if (head.onAbort) head.signal?.removeEventListener("abort", head.onAbort);
      head.admit(this.#join(head.spaceId, head.mode));
      if (head.mode === "exclusive") return;
    }
  }
}

function assertSpaceId(spaceId: number): void {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError("spaceId must be a non-negative integer");
  }
}

const defaultGate = new NativeOperationGate({
  async selectSpace(spaceId) {
    const ego = browserEgo();
    if (typeof ego.useTaskSpace !== "function") {
      throw new Error("withSpace requires ego.useTaskSpace");
    }
    await invokeEgo("withSpace", () => ego.useTaskSpace(spaceId));
  },
  ensureSession,
});

export function withSpace<T>(
  spaceId: number,
  operation: (scope: SpaceScope) => T | Promise<T>,
  options: WithSpaceOptions = {},
): Promise<T> {
  return defaultGate.withSpace(spaceId, operation, options);
}

export function withPage<T>(
  page: PageTarget,
  operation: (context: PageExecutionContext) => T | Promise<T>,
  options: WithPageOptions = {},
): Promise<T> {
  return defaultGate.withPage(page, operation, options);
}
