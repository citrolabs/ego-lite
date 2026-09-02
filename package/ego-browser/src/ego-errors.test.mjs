import test from "node:test";
import assert from "node:assert/strict";
import {
  EgoError,
  ElementResolutionError,
  NavigationTimeoutError,
  DialogBlockingError,
  ConnectionLostError,
  TimeoutError,
  mapCdpError,
} from "../dist/src/ego-errors.js";
import { __testing } from "../dist/src/helpers.js";

test("EgoError has required shape", () => {
  const err = new EgoError("test error", "transient", "TEST_ERROR", undefined, "Custom hint");
  assert.equal(err.kind, "transient");
  assert.equal(err.code, "TEST_ERROR");
  assert.ok(typeof err.context.timestamp === "number");
  assert.ok(err.recoveryHint !== undefined);
  assert.ok(err.recoveryHint.length > 0);
});

test("EgoError context includes timestamp", () => {
  const err = new EgoError("test", "permanent", "TEST");
  assert.ok(err.context.timestamp > 0);
});

test("transient errors have recoveryHint", () => {
  const err = new ElementResolutionError("not found", "transient");
  assert.ok(typeof err.recoveryHint === "string" && err.recoveryHint.length > 0);
});

test("permanent errors have recoveryHint", () => {
  const err = new ElementResolutionError("invalid selector", "permanent");
  assert.ok(err.recoveryHint !== undefined);
  assert.ok(err.recoveryHint.length > 0);
});

test("NavigationTimeoutError has correct kind", () => {
  const err = new NavigationTimeoutError("page load timeout");
  assert.equal(err.kind, "transient");
  assert.equal(err.code, "NAVIGATION_TIMEOUT");
});

test("DialogBlockingError has correct kind", () => {
  const err = new DialogBlockingError("alert blocking");
  assert.equal(err.kind, "transient");
  assert.equal(err.code, "DIALOG_BLOCKING");
});

test("ConnectionLostError has correct kind", () => {
  const err = new ConnectionLostError("connection dropped");
  assert.equal(err.kind, "transient");
  assert.equal(err.code, "CONNECTION_LOST");
});

test("Error hierarchy preserves message", () => {
  const err = new ElementResolutionError("custom message", "transient");
  assert.equal(err.message, "custom message");
});

test("Error serialization includes kind and code", () => {
  const err = new ElementResolutionError("test", "transient");
  const json = JSON.stringify(err);
  assert.ok(json.includes('"kind":"transient"'));
  assert.ok(json.includes('"code":"ELEMENT_NOT_FOUND"'));
});

test("recoveryHint is safe (no URL leakage)", () => {
  // Create an error with a sensitive URL in context
  const err = new EgoError("navigation failed", "transient", "NAV_FAILED", {
    url: "https://example.com/secret?token=abc123xyz",
  }, "Check the URL and retry.");
  // The recoveryHint itself should never echo the URL
  assert.ok(!err.recoveryHint.includes("abc123xyz"));
  assert.ok(!err.recoveryHint.includes("secret"));
  assert.equal(err.context.url, "https://example.com/secret");
  assert.ok(!JSON.stringify(err.toJSON()).includes("abc123xyz"));
});

test("TimeoutError exists and has correct shape", () => {
  const err = new TimeoutError("pageLoad", 5000);
  assert.equal(err.kind, "transient");
  assert.equal(err.code, "TIMEOUT");
  assert.ok(typeof err.recoveryHint === "string");
  assert.ok(err.recoveryHint.length > 0);
});

test("context.timestamp is always present", () => {
  const err = new NavigationTimeoutError("timeout");
  assert.ok(typeof err.context.timestamp === "number");
  assert.ok(err.context.timestamp > 0);
});

test("NavigationTimeoutError redacts sensitive URL from message and toJSON", () => {
  const err = new NavigationTimeoutError("https://example.com/page?token=abc123xyz&foo=bar", 5000);
  // Message must not contain query params (where tokens live)
  assert.ok(!err.message.includes("abc123xyz"));
  assert.ok(!err.message.includes("foo=bar"));
  assert.ok(!err.message.includes("?"));
  // Message should contain the redacted URL (domain+path only)
  assert.ok(err.message.includes("example.com"));
  assert.ok(err.message.includes("/page"));
  // toJSON must also not leak
  const json = err.toJSON();
  assert.ok(!json.message.includes("abc123xyz"));
  assert.equal(err.context.url, "https://example.com/page");
  assert.ok(!JSON.stringify(json).includes("abc123xyz"));
});

test("mapCdpError applies session-loss and timeout precedence", () => {
  const lost = mapCdpError(new Error("Session not found"), {
    operation: "Runtime.evaluate",
    url: "https://example.com/private?token=SEKRET",
  });
  assert.ok(lost instanceof ConnectionLostError);
  assert.equal(lost.context.url, "https://example.com/private");

  const navigation = mapCdpError(new Error("request timed out"), {
    operation: "navigate",
    url: "https://example.com/page",
    timeoutMs: 5000,
  });
  assert.ok(navigation instanceof NavigationTimeoutError);
  assert.equal(navigation.context.url, "https://example.com/page");
  assert.match(navigation.message, /5000ms/);

  const operation = mapCdpError(new Error("timeout"), {
    operation: "waitForSelector",
    timeoutMs: 250,
  });
  assert.ok(operation instanceof TimeoutError);
  assert.equal(operation.code, "TIMEOUT");
});

test("error taxonomy mutation seam exposes defective mapping", () => {
  const dispose = __testing.setErrorTaxonomyOverrides({
    mapCdpError: () => new Error("generic"),
  });
  try {
    const mapped = __testing.mapCdpError(new Error("Session not found"), {
      operation: "Runtime.evaluate",
    });
    assert.ok(!(mapped instanceof EgoError));
  } finally {
    dispose();
  }
  assert.ok(
    __testing.mapCdpError(new Error("Session not found"), {
      operation: "Runtime.evaluate",
    }) instanceof ConnectionLostError,
  );
});

test("URL without query or fragment is preserved", () => {
  const err = new NavigationTimeoutError("https://ex.com/s", 5000);
  assert.equal(err.context.url, "https://ex.com/s");
  assert.match(err.message, /https:\/\/ex\.com\/s/);
});
