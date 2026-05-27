export function formatCliLogValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}
