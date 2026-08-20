import test from "node:test";
import assert from "node:assert/strict";
import {
  EGO_ERROR_CODES,
  makeEgoError,
  egoError,
  egoResultError,
  isUserControlCode,
  isEgoErrorCode,
} from "./errors.js";

test("EGO_ERROR_CODES includes stable known codes", () => {
  assert.ok(EGO_ERROR_CODES.includes("EGO_BROWSER_UNAVAILABLE"));
  assert.ok(EGO_ERROR_CODES.includes("EGO_TASK_SPACE_USER_IN_CONTROL"));
  assert.ok(EGO_ERROR_CODES.includes("EGO_TASK_SPACE_INACTIVE"));
  assert.equal(EGO_ERROR_CODES.length, 15);
});

test("isEgoErrorCode narrows known codes", () => {
  assert.equal(isEgoErrorCode("EGO_SNAPSHOT_FAILED"), true);
  assert.equal(isEgoErrorCode("EGO_FUTURE_CODE"), false);
  assert.equal(isEgoErrorCode(undefined), false);
});

test("makeEgoError attaches error_code", () => {
  const err = makeEgoError("EGO_BROWSER_UNAVAILABLE", "chrome missing");
  assert.equal(err.message, "chrome missing");
  assert.equal(err.error_code, "EGO_BROWSER_UNAVAILABLE");
  assert.ok(err instanceof Error);
});

test("egoError is an alias of makeEgoError", () => {
  const err = egoError("EGO_OPERATION_FAILED", "nope");
  assert.equal(err.error_code, "EGO_OPERATION_FAILED");
  assert.equal(err.message, "nope");
});

test("egoResultError returns resolved error shape", () => {
  assert.deepEqual(egoResultError("EGO_SNAPSHOT_FAILED", "boom"), {
    error: "boom",
    error_code: "EGO_SNAPSHOT_FAILED",
  });
});

test("isUserControlCode keys on USER_IN_CONTROL", () => {
  assert.equal(isUserControlCode("EGO_TASK_SPACE_USER_IN_CONTROL"), true);
  assert.equal(isUserControlCode("EGO_TASK_SPACE_INACTIVE"), false);
  assert.equal(isUserControlCode("EGO_SNAPSHOT_FAILED"), false);
});
