import test from "node:test";
import assert from "node:assert/strict";

import {
  egoErrorCode,
  invokeEgo,
  isEgoErrorCode,
  isEgoUserControlError,
  probeAgentControl,
  resolveEgoError,
} from "../dist/src/ego-errors.js";

test("probeAgentControl treats both native user-control shapes as waiting", async () => {
  assert.equal(
    await probeAgentControl(async () => ({
      error: "manual_takeover",
      error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
    })),
    false,
  );
  assert.equal(
    await probeAgentControl(async () => {
      throw Object.assign(new Error("manual_takeover"), {
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      });
    }),
    false,
  );
});

test("probeAgentControl propagates non-user-control native errors", async () => {
  await assert.rejects(
    () =>
      probeAgentControl(async () => ({
        error: "renderer failed",
        error_code: "EGO_SNAPSHOT_FAILED",
      })),
    /renderer failed/,
  );
});

test("invokeEgo recognizes a permission reason from a resolved native error", async () => {
  await assert.rejects(
    () =>
      invokeEgo("task.listTabs", () =>
        Promise.resolve({
          error: "location",
          error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
        }),
      ),
    (error) => {
      assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      assert.match(
        error.message,
        /^task\.listTabs: A browser permission prompt/,
      );
      assert.match(error.message, /location access/);
      assert.match(error.message, /takeOverTaskSpace\(spaceId\)/);
      return true;
    },
  );
});

test("invokeEgo recognizes a permission reason from a rejected native call", async () => {
  const nativeError = Object.assign(new Error("camera"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  await assert.rejects(
    () => invokeEgo("snapshot", () => Promise.reject(nativeError)),
    (error) => {
      assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      assert.match(error.message, /^snapshot: A browser permission prompt/);
      assert.match(error.message, /camera access/);
      return true;
    },
  );
});

test("user-control reason lookup ignores inherited object properties", () => {
  const { message } = resolveEgoError({
    error: "constructor",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /The user has taken control/);
  assert.doesNotMatch(message, /constructor/);
});

test("unknown user-control reasons fall back without exposing the raw key", () => {
  const { message } = resolveEgoError({
    error: "future_permission_reason",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /The user has taken control/);
  assert.doesNotMatch(message, /future_permission_reason/);
});

test("the retired site-dialog handoff reason uses generic user-control guidance", () => {
  const { message } = resolveEgoError({
    error: "fallback_site_dialog_required_notice",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /The user has taken control/);
  assert.doesNotMatch(message, /dialog that requires review/);
  assert.doesNotMatch(message, /fallback_site_dialog_required_notice/);
});

test("invokeEgo preserves non-user-control native failures", async () => {
  await assert.rejects(
    () =>
      invokeEgo("snapshot", () =>
        Promise.reject(
          Object.assign(new Error("snapshot renderer failed"), {
            error_code: "EGO_SNAPSHOT_FAILED",
          }),
        ),
      ),
    (error) => {
      assert.equal(error.error_code, "EGO_SNAPSHOT_FAILED");
      assert.equal(error.message, "snapshot: snapshot renderer failed");
      return true;
    },
  );
});

test("egoErrorCode extracts the code from every error shape", () => {
  // resolved { error, error_code } object
  assert.equal(
    egoErrorCode({ error: "nope", error_code: "EGO_BROWSER_UNAVAILABLE" }),
    "EGO_BROWSER_UNAVAILABLE",
  );
  // rejected / thrown Error carrying .error_code
  const err = Object.assign(new Error("boom"), {
    error_code: "EGO_SNAPSHOT_FAILED",
  });
  assert.equal(egoErrorCode(err), "EGO_SNAPSHOT_FAILED");
  // bare known code string (e.g. onSendCDPMessageError second arg)
  assert.equal(
    egoErrorCode("EGO_TASK_SPACE_USER_IN_CONTROL"),
    "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  // future code this build does not know about is still returned
  assert.equal(
    egoErrorCode({ error_code: "EGO_FUTURE_CODE" }),
    "EGO_FUTURE_CODE",
  );
  // no code present
  assert.equal(egoErrorCode({ error: "plain message" }), undefined);
  assert.equal(egoErrorCode("plain message"), undefined);
});

test("isEgoErrorCode narrows to known codes only", () => {
  assert.equal(isEgoErrorCode("EGO_TASK_SPACE_NOT_FOUND"), true);
  assert.equal(isEgoErrorCode("EGO_FUTURE_CODE"), false);
  assert.equal(isEgoErrorCode(undefined), false);
});

test("resolveEgoError overrides the native error message with the owned wording for an owned code", () => {
  const { code, message } = resolveEgoError({
    error: "Task space 7 is not assigned to an agent.",
    error_code: "EGO_TASK_SPACE_INACTIVE",
  });
  assert.equal(code, "EGO_TASK_SPACE_INACTIVE");
  // Owned id-less guidance replaces the native "Task space 7 ..." text.
  assert.match(message, /claimTaskSpace\(spaceId\)/);
  assert.doesNotMatch(message, /\b7\b/);
});

test("resolveEgoError keeps the native error message for an unknown future code", () => {
  assert.deepEqual(
    resolveEgoError({
      error: "Some build-specific detail",
      error_code: "EGO_FUTURE_CODE",
    }),
    {
      code: "EGO_FUTURE_CODE",
      message: "Some build-specific detail",
    },
  );
});

test("resolveEgoError defers to the native error message for a code ego-browser does not own", () => {
  // EGO_OPERATION_FAILED is not owned: the client wording (e.g. which operation
  // failed) is more specific than any static line.
  assert.deepEqual(
    resolveEgoError({
      error: "Failed to create task space",
      error_code: "EGO_OPERATION_FAILED",
    }),
    {
      code: "EGO_OPERATION_FAILED",
      message: "Failed to create task space",
    },
  );
});

test("resolveEgoError falls back to the raw code for a bare non-owned code", () => {
  // ego-browser does not own NOT_SELECTED and a bare code carries no native error message,
  // so the stable code itself is the most specific thing to surface.
  assert.deepEqual(resolveEgoError("EGO_TASK_SPACE_NOT_SELECTED"), {
    code: "EGO_TASK_SPACE_NOT_SELECTED",
    message: "EGO_TASK_SPACE_NOT_SELECTED",
  });
});

test("resolveEgoError uses the id-less guidance block for a bare user-control code", () => {
  const { code, message } = resolveEgoError("EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(code, "EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.match(message, /taken control of this task space/);
  assert.match(message, /takeOverTaskSpace\(spaceId\)/);
  assert.doesNotMatch(message, /<id>/);
});

test("resolveEgoError falls back to the raw code, then a generic message", () => {
  assert.deepEqual(resolveEgoError({ error_code: "EGO_FUTURE_CODE" }), {
    code: "EGO_FUTURE_CODE",
    message: "EGO_FUTURE_CODE",
  });
  assert.deepEqual(resolveEgoError({}), {
    code: undefined,
    message: "Unknown ego error",
  });
});

test("isEgoUserControlError keys on the stable code, not wording", () => {
  assert.equal(
    isEgoUserControlError(
      Object.assign(new Error("anything at all"), {
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      }),
    ),
    true,
  );
  // wording that mentions user control but lacks the code is not a match
  assert.equal(
    isEgoUserControlError(new Error("the user is controlling this")),
    false,
  );
  assert.equal(
    isEgoUserControlError({ error_code: "EGO_SNAPSHOT_FAILED" }),
    false,
  );
});

test("invokeEgo resolves native error objects and attaches error_code", async () => {
  await assert.rejects(
    () =>
      invokeEgo("listTabs", () => ({
        error: "Task space not selected",
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      })),
    (error) => {
      assert.equal(error.message, "listTabs: Task space not selected");
      assert.equal(error.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
      return true;
    },
  );
});

test("invokeEgo normalizes synchronous native throws", async () => {
  const nativeError = Object.assign(new Error("native setup failed"), {
    error_code: "EGO_OPERATION_FAILED",
  });
  await assert.rejects(
    () =>
      invokeEgo("createTab", () => {
        throw nativeError;
      }),
    (error) => {
      assert.equal(error.message, "createTab: native setup failed");
      assert.equal(error.error_code, "EGO_OPERATION_FAILED");
      return true;
    },
  );
});

test("invokeEgo passes through successful results", async () => {
  const ok = { tabs: [] };
  assert.equal(await invokeEgo("listTabs", () => ok), ok);
});
