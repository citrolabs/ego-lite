import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_TARGET_STATE_HELPERS,
  HIT_TARGET_HELPERS,
  SCROLL_TARGET_HELPERS,
} from "../../dist/src/driver/action-target.js";

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

test("scroll targeting recognizes an element clipped by a nested scroller", () => {
  const { scrollRequestForPoint } = Function(`
    ${SCROLL_TARGET_HELPERS}
    return { scrollRequestForPoint };
  `)();
  const body = { parentElement: null };
  const documentElement = { parentElement: null };
  const view = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle() {
      return { overflowX: "hidden", overflowY: "auto" };
    },
  };
  const ownerDocument = { body, documentElement, defaultView: view };
  const scroller = {
    ownerDocument,
    parentElement: body,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 300,
    clientWidth: 300,
    scrollHeight: 900,
    clientHeight: 120,
    getBoundingClientRect() {
      return { left: 20, top: 100, right: 320, bottom: 220 };
    },
  };
  const target = { ownerDocument, parentElement: scroller };

  assert.deepEqual(scrollRequestForPoint(target, { x: 80, y: 700 }), {
    x: 170,
    y: 160,
    deltaX: 0,
    deltaY: 540,
  });
  assert.equal(scrollRequestForPoint(target, { x: 80, y: 160 }), null);
});

test("action targeting chooses a real inline fragment instead of the bounding-box gap", () => {
  const { actionPointForElement } = Function(`
    ${HIT_TARGET_HELPERS}
    return { actionPointForElement };
  `)();
  const target = {
    ownerDocument: {
      defaultView: { innerWidth: 800, innerHeight: 600 },
    },
    getClientRects() {
      return [
        { left: 700, top: 100, right: 780, bottom: 120, width: 80, height: 20 },
        { left: 20, top: 140, right: 100, bottom: 160, width: 80, height: 20 },
      ];
    },
    getBoundingClientRect() {
      return {
        left: 20,
        top: 100,
        right: 780,
        bottom: 160,
        width: 760,
        height: 60,
      };
    },
  };

  assert.deepEqual(actionPointForElement(target), { x: 740, y: 110 });
});
