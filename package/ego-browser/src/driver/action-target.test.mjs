import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_TARGET_STATE_HELPERS } from "../../dist/src/driver/action-target.js";

function stateHelpers() {
  return Function(`
    ${ACTION_TARGET_STATE_HELPERS}
    return { isActionTargetDisabled };
  `)();
}

function element({
  tagName = "DIV",
  parentElement = null,
  assignedSlot = null,
  rootHost = null,
  disabled = false,
  ariaDisabled,
  role,
  href = false,
  contentEditable = false,
} = {}) {
  return {
    tagName,
    parentElement,
    assignedSlot,
    disabled,
    isContentEditable: contentEditable,
    getAttribute(name) {
      if (name === "aria-disabled") return ariaDisabled ?? null;
      if (name === "role") return role ?? null;
      return null;
    },
    hasAttribute(name) {
      return name === "href" ? href : false;
    },
    getRootNode() {
      return rootHost ? { nodeType: 11, host: rootHost } : { nodeType: 9 };
    },
    matches(selector) {
      assert.equal(selector, ":disabled");
      return disabled;
    },
  };
}

test("action enabled state follows native controls and composed ARIA ancestry", () => {
  const { isActionTargetDisabled } = stateHelpers();

  const disabledButton = element({ tagName: "BUTTON", disabled: true });
  const nestedSpan = element({
    tagName: "SPAN",
    parentElement: disabledButton,
  });
  assert.equal(isActionTargetDisabled(nestedSpan), true);

  const ariaContainer = element({ ariaDisabled: " TRUE " });
  const inherited = element({
    tagName: "BUTTON",
    parentElement: ariaContainer,
  });
  assert.equal(isActionTargetDisabled(inherited), true);

  const overridden = element({
    tagName: "BUTTON",
    parentElement: ariaContainer,
    ariaDisabled: "false",
  });
  assert.equal(isActionTargetDisabled(overridden), false);

  const nativeWins = element({
    tagName: "BUTTON",
    disabled: true,
    ariaDisabled: "false",
  });
  assert.equal(isActionTargetDisabled(nativeWins), true);
});

test("action enabled state crosses shadow hosts and assigned slots", () => {
  const { isActionTargetDisabled } = stateHelpers();

  const host = element({ ariaDisabled: "true" });
  const shadowChild = element({ tagName: "BUTTON", rootHost: host });
  assert.equal(isActionTargetDisabled(shadowChild), true);

  const slot = element({ tagName: "SLOT", rootHost: host });
  const slottedChild = element({ tagName: "BUTTON", assignedSlot: slot });
  assert.equal(isActionTargetDisabled(slottedChild), true);

  const slottedOverride = element({
    tagName: "BUTTON",
    assignedSlot: slot,
    ariaDisabled: "false",
  });
  assert.equal(isActionTargetDisabled(slottedOverride), false);
});

test("action enabled state uses the nearest interactive owner for ARIA", () => {
  const { isActionTargetDisabled } = stateHelpers();

  const disabledButton = element({
    tagName: "BUTTON",
    ariaDisabled: "true",
  });
  const unsupportedOverride = element({
    tagName: "SPAN",
    parentElement: disabledButton,
    ariaDisabled: "false",
  });
  assert.equal(
    isActionTargetDisabled(unsupportedOverride),
    true,
    "aria-disabled=false on button content does not override the button",
  );

  const innerButton = element({
    parentElement: disabledButton,
    role: "button",
    ariaDisabled: "false",
  });
  const innerText = element({ tagName: "SPAN", parentElement: innerButton });
  assert.equal(
    isActionTargetDisabled(innerText),
    false,
    "a nested interactive owner can explicitly override its ancestor",
  );

  const unsupportedTarget = element({ ariaDisabled: "true" });
  assert.equal(
    isActionTargetDisabled(unsupportedTarget),
    false,
    "aria-disabled does not disable a target without a supporting role",
  );
});
