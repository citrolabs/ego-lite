export class RefMap {
  map: Map<string, any>;
  nextRef: number;

  constructor() {
    this.map = new Map();
    this.nextRef = 1;
  }

  add(refId, backendNodeId, role, name, nth = undefined) {
    this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
  }

  addWithFrame(refId, backendNodeId, role, name, nth = undefined, frameId = undefined) {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      selector: undefined,
      frameId
    });
  }

  addSelector(refId, selector, role, name, nth = undefined) {
    this.map.set(refId, {
      backendNodeId: undefined,
      role,
      name,
      nth,
      selector,
      frameId: undefined
    });
  }

  get(refId) {
    return this.map.get(refId);
  }

  entriesSorted() {
    return [...this.map.entries()].sort(([left], [right]) => refSortKey(left) - refSortKey(right));
  }

  remove(refId) {
    this.map.delete(refId);
  }

  clear() {
    this.map.clear();
    this.nextRef = 1;
  }

  nextRefNum() {
    return this.nextRef;
  }

  setNextRefNum(value) {
    this.nextRef = value;
  }
}

export function parseRef(input) {
  const trimmed = String(input || "").trim();
  for (const candidate of [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function refSortKey(refId) {
  const match = /^(\d+)$/.exec(refId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
