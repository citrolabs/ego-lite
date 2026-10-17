import { inspect } from "node:util";

export function formatCliLogValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, {
    depth: 6,
    breakLength: Infinity,
    compact: true,
  });
}
