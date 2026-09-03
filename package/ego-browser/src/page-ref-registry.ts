import { RefMap } from "./ref-map.js";

const MAX_INVALIDATED_REFS_PER_TARGET = 10_000;

type SnapshotRef = {
  refId?: string | number;
  backendNodeId?: number;
  frameId?: string;
  frameProvenance?: "page" | "frame" | "unknown";
  role?: string;
  name?: string;
};

/**
 * Keeps native snapshot refs isolated by browser target. The printed ref stays
 * compact (`@21`), while the Page carrying the target id supplies its scope.
 */
export class PageRefRegistry {
  readonly #targets = new Map<string, RefMap>();
  readonly #invalidated = new Map<string, Set<string>>();

  forTarget(targetId: string): RefMap {
    assertTargetId(targetId);
    let refs = this.#targets.get(targetId);
    if (!refs) {
      refs = new RefMap();
      this.#targets.set(targetId, refs);
    }
    return refs;
  }

  replace(targetId: string, snapshotRefs: SnapshotRef[] = []): RefMap {
    assertTargetId(targetId);
    const invalidated = new Set(this.#invalidated.get(targetId) || []);
    for (const refId of this.#targets.get(targetId)?.map.keys() || []) {
      addInvalidatedRef(invalidated, refId);
    }
    const refs = new RefMap();
    for (const ref of snapshotRefs) {
      if (
        !ref ||
        typeof ref !== "object" ||
        ref.backendNodeId === undefined ||
        ref.backendNodeId === null
      ) {
        continue;
      }
      const refId = String(ref.refId ?? ref.backendNodeId);
      refs.addWithFrame(
        refId,
        ref.backendNodeId,
        ref.role,
        ref.name,
        undefined,
        ref.frameId,
        ref.frameProvenance,
      );
      invalidated.delete(refId);
    }
    this.#targets.set(targetId, refs);
    if (invalidated.size > 0) this.#invalidated.set(targetId, invalidated);
    else this.#invalidated.delete(targetId);
    return refs;
  }

  merge(targetId: string, snapshotRefs: SnapshotRef[] = []): RefMap {
    assertTargetId(targetId);
    const refs = this.forTarget(targetId);
    const invalidated = new Set(this.#invalidated.get(targetId) || []);
    for (const ref of snapshotRefs) {
      if (
        !ref ||
        typeof ref !== "object" ||
        ref.backendNodeId === undefined ||
        ref.backendNodeId === null
      ) {
        continue;
      }
      const refId = String(ref.refId ?? ref.backendNodeId);
      refs.addWithFrame(
        refId,
        ref.backendNodeId,
        ref.role,
        ref.name,
        undefined,
        ref.frameId,
        ref.frameProvenance,
      );
      invalidated.delete(refId);
    }
    if (invalidated.size > 0) this.#invalidated.set(targetId, invalidated);
    else this.#invalidated.delete(targetId);
    return refs;
  }

  invalidate(targetId: string): void {
    assertTargetId(targetId);
    const invalidated = this.#invalidated.get(targetId) ?? new Set<string>();
    for (const refId of this.#targets.get(targetId)?.map.keys() || []) {
      addInvalidatedRef(invalidated, refId);
    }
    this.#targets.delete(targetId);
    if (invalidated.size > 0) this.#invalidated.set(targetId, invalidated);
  }

  isInvalidated(targetId: string, refId: string): boolean {
    assertTargetId(targetId);
    return this.#invalidated.get(targetId)?.has(refId) ?? false;
  }

  clear(targetId: string): void {
    assertTargetId(targetId);
    this.#targets.delete(targetId);
    this.#invalidated.delete(targetId);
  }
}

function assertTargetId(targetId: string): void {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new TypeError("PageRefRegistry requires a non-empty targetId");
  }
}

function addInvalidatedRef(invalidated: Set<string>, refId: string): void {
  invalidated.delete(refId);
  invalidated.add(refId);
  if (invalidated.size <= MAX_INVALIDATED_REFS_PER_TARGET) return;
  const oldest = invalidated.values().next().value;
  if (oldest !== undefined) invalidated.delete(oldest);
}
