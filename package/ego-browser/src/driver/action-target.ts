/**
 * Browser-side helpers shared by selector actions that need composed-tree
 * relationships. Keep action policy at each call site: pointer actions and
 * editing actions intentionally do not retarget in the same way.
 */
export const COMPOSED_PARENT_HELPER = `
  function composedParent(element) {
    if (element?.assignedSlot) return element.assignedSlot;
    if (element?.parentElement) return element.parentElement;
    const root = element?.getRootNode ? element.getRootNode() : null;
    return root && root.nodeType === 11 ? root.host : null;
  }
`;

export const COMPOSED_TREE_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  function composedChildren(element) {
    if (!element) return [];
    if (String(element.tagName || "").toUpperCase() === "SLOT") {
      const assigned = element.assignedElements?.({ flatten: true }) || [];
      if (assigned.length > 0) return assigned;
    }
    const container = element.shadowRoot || element;
    return Array.from(container.children || []);
  }
  function nearestComposedAncestor(element, predicate) {
    let current = composedParent(element);
    while (current) {
      if (predicate(current)) return current;
      current = composedParent(current);
    }
    return null;
  }
  function composedDescendantMatches(root, predicate, stopAtMatch = false) {
    const matches = [];
    const visit = (parent) => {
      for (const child of composedChildren(parent)) {
        const matched = predicate(child);
        if (matched) matches.push(child);
        if (!(matched && stopAtMatch)) visit(child);
      }
    };
    visit(root);
    return matches;
  }
`;

const ACTION_TARGET_STATE_FUNCTIONS = `
  const nativeActionControlTags = new Set([
    "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP"
  ]);
  const ariaDisabledActionRoles = new Set([
    "application", "button", "composite", "gridcell", "group", "input",
    "link", "menuitem", "scrollbar", "separator", "tab", "checkbox",
    "columnheader", "combobox", "grid", "listbox", "menu", "menubar",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "radiogroup",
    "row", "rowheader", "searchbox", "select", "slider", "spinbutton",
    "switch", "tablist", "textbox", "toolbar", "tree", "treegrid",
    "treeitem"
  ]);
  function actionStateRole(element) {
    const explicit = String(element?.getAttribute?.("role") || "")
      .trim().toLowerCase().split(/\\s+/)[0];
    if (explicit) return explicit;
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "INPUT") return "input";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA" || element?.isContentEditable) return "textbox";
    if (tag === "OPTION") return "option";
    if (tag === "OPTGROUP" || tag === "FIELDSET") return "group";
    if (
      (tag === "A" || tag === "AREA") &&
      element?.hasAttribute?.("href")
    ) return "link";
    return "";
  }
  function supportsAriaDisabled(element) {
    return ariaDisabledActionRoles.has(actionStateRole(element));
  }
  function actionStateOwner(element) {
    let current = element;
    while (current) {
      if (supportsAriaDisabled(current)) return current;
      current = composedParent(current);
    }
    return null;
  }
  function isNativelyDisabledForAction(element) {
    let current = element;
    while (current) {
      const tag = String(current.tagName || "").toUpperCase();
      if (
        nativeActionControlTags.has(tag) &&
        (current.disabled === true || current.matches?.(":disabled"))
      ) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  }
  function hasInheritedAriaDisabled(element) {
    let current = actionStateOwner(element);
    while (current) {
      const value = String(
        current.getAttribute?.("aria-disabled") ?? ""
      ).trim().toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      current = composedParent(current);
    }
    return false;
  }
  function isActionTargetDisabled(element) {
    return (
      isNativelyDisabledForAction(element) ||
      hasInheritedAriaDisabled(element)
    );
  }
`;

/** Browser-side enabled semantics shared by resolution and final input checks. */
export const ACTION_TARGET_STATE_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  ${ACTION_TARGET_STATE_FUNCTIONS}
`;

const SCROLL_TARGET_FUNCTIONS = `
  function actionPointForElement(target) {
    const view = target?.ownerDocument?.defaultView;
    if (!view) return null;
    const rects = Array.from(target.getClientRects?.() || []).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    if (rects.length === 0) {
      const rect = target.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      rects.push(rect);
    }
    let best = null;
    for (const rect of rects) {
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(view.innerWidth, rect.right);
      const bottom = Math.min(view.innerHeight, rect.bottom);
      const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      const distanceX = centerX - Math.max(0, Math.min(view.innerWidth, centerX));
      const distanceY = centerY - Math.max(0, Math.min(view.innerHeight, centerY));
      const viewportDistance = distanceX * distanceX + distanceY * distanceY;
      if (
        !best ||
        visibleArea > best.visibleArea ||
        (visibleArea === best.visibleArea && viewportDistance < best.viewportDistance)
      ) {
        best = { rect, left, top, right, bottom, visibleArea, viewportDistance };
      }
    }
    if (best.visibleArea > 0) {
      return {
        x: (best.left + best.right) / 2,
        y: (best.top + best.bottom) / 2,
      };
    }
    return {
      x: (best.rect.left + best.rect.right) / 2,
      y: (best.rect.top + best.rect.bottom) / 2,
    };
  }
  function visibleScrollArea(rect, view) {
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(view.innerWidth, rect.right),
      bottom: Math.min(view.innerHeight, rect.bottom),
    };
  }
  function scrollRequestForPoint(target, point) {
    const view = target?.ownerDocument?.defaultView;
    if (!view) return null;
    let ancestor = composedParent(target);
    while (ancestor) {
      if (
        ancestor !== target.ownerDocument.body &&
        ancestor !== target.ownerDocument.documentElement
      ) {
        const style = view.getComputedStyle(ancestor);
        const canScrollX =
          /^(auto|scroll|overlay)$/.test(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth + 1;
        const canScrollY =
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight + 1;
        if (canScrollX || canScrollY) {
          const area = visibleScrollArea(ancestor.getBoundingClientRect(), view);
          if (area.right > area.left && area.bottom > area.top) {
            let deltaX = canScrollX &&
                (point.x < area.left || point.x >= area.right)
              ? point.x - (area.left + area.right) / 2
              : 0;
            let deltaY = canScrollY &&
                (point.y < area.top || point.y >= area.bottom)
              ? point.y - (area.top + area.bottom) / 2
              : 0;
            if (
              (deltaX < 0 && ancestor.scrollLeft <= 0) ||
              (deltaX > 0 && ancestor.scrollLeft >= ancestor.scrollWidth - ancestor.clientWidth - 1)
            ) deltaX = 0;
            if (
              (deltaY < 0 && ancestor.scrollTop <= 0) ||
              (deltaY > 0 && ancestor.scrollTop >= ancestor.scrollHeight - ancestor.clientHeight - 1)
            ) deltaY = 0;
            if (deltaX || deltaY) {
              return {
                x: (area.left + area.right) / 2,
                y: (area.top + area.bottom) / 2,
                deltaX,
                deltaY,
              };
            }
          }
        }
      }
      ancestor = composedParent(ancestor);
    }
    if (
      point.x >= 0 && point.y >= 0 &&
      point.x < view.innerWidth && point.y < view.innerHeight
    ) return null;
    return {
      x: Math.max(0, Math.min(view.innerWidth - 1, point.x)),
      y: Math.max(0, Math.min(view.innerHeight - 1, point.y)),
      deltaX: point.x - view.innerWidth / 2,
      deltaY: point.y - view.innerHeight / 2,
    };
  }
`;

/** Browser-side scroll targeting shared by candidate selection and actions. */
export const SCROLL_TARGET_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  ${SCROLL_TARGET_FUNCTIONS}
`;

/** Editing semantics layered on top of the shared composed-tree traversal. */
export const EDIT_ACTION_TARGET_HELPERS = `
  ${COMPOSED_TREE_HELPERS}
  ${ACTION_TARGET_STATE_FUNCTIONS}
  function isExplicitContentEditable(element) {
    return Boolean(
      element?.hasAttribute?.("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    );
  }
  function isFillableInput(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    return new Set([
      "", "color", "date", "datetime-local", "email", "month", "number",
      "password", "range", "search", "tel", "text", "time", "url", "week"
    ]).has(String(element.type || "").toLowerCase());
  }
  function isFillableActionTarget(element) {
    return isExplicitContentEditable(element) || isFillableInput(element);
  }
  function isEditableFocusTarget(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    const editableRole = new Set([
      "textbox", "searchbox", "combobox", "spinbutton"
    ]).has(
      String(element?.getAttribute?.("role") || "").toLowerCase()
    );
    return (
      (isFillableActionTarget(element) || tag === "SELECT" || editableRole) &&
      !isActionTargetDisabled(element)
    );
  }
  function isStrongFocusTarget(element) {
    if (
      !element?.isConnected ||
      isActionTargetDisabled(element) ||
      element.closest?.("[inert]")
    ) {
      return false;
    }
    if (isEditableFocusTarget(element)) return true;
    const tag = String(element.tagName || "").toUpperCase();
    if (["BUTTON", "SELECT", "TEXTAREA", "SUMMARY", "IFRAME"].includes(tag)) {
      return true;
    }
    if (tag === "INPUT") return String(element.type || "").toLowerCase() !== "hidden";
    if ((tag === "A" || tag === "AREA") && element.hasAttribute("href")) return true;
    if ((tag === "AUDIO" || tag === "VIDEO") && element.hasAttribute("controls")) {
      return true;
    }
    return new Set([
      "button", "checkbox", "link", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "radio", "slider", "switch", "tab", "treeitem"
    ]).has(String(element.getAttribute?.("role") || "").toLowerCase());
  }
`;

// Shared by resolver-level candidate selection and the final pointer check.
// Keeping one composed-tree definition prevents the two stages from disagreeing
// about shadow descendants, interactive ancestors, or modal blockers.
export const HIT_TARGET_HELPERS = `
  ${ACTION_TARGET_STATE_HELPERS}
  ${SCROLL_TARGET_FUNCTIONS}
  function isExplicitInteractiveElement(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "SUMMARY", "LABEL"].includes(tag)) {
      return true;
    }
    if (tag === "A" && element.hasAttribute?.("href")) return true;
    if (
      element?.hasAttribute?.("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    ) return true;
    return new Set([
      "button",
      "checkbox",
      "link",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "radio",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem"
    ]).has(String(element?.getAttribute?.("role") || "").toLowerCase());
  }
  function isInteractiveElement(element) {
    return isExplicitInteractiveElement(element) || Boolean(element?.isContentEditable);
  }
  function hitElementAtPoint(target, point) {
    const roots = [];
    let parent = target;
    while (parent) {
      const root = parent.getRootNode ? parent.getRootNode() : null;
      if (!root || typeof root.elementsFromPoint !== "function") break;
      roots.push(root);
      if (root.nodeType === 9) break;
      parent = root.host;
    }
    let hitElement;
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const root = roots[index];
      const elements = root.elementsFromPoint(point.x, point.y);
      const innerElement = elements[0] || root.elementFromPoint(point.x, point.y);
      if (!innerElement) break;
      hitElement = innerElement;
      if (index > 0 && innerElement !== roots[index - 1].host) break;
    }
    return hitElement;
  }
  function interceptingElementAtPoint(target, point) {
    const hitElement = hitElementAtPoint(target, point);
    let current = hitElement;
    while (current && current !== target) current = composedParent(current);
    if (current === target) return null;

    current = target;
    while (current && current !== hitElement) current = composedParent(current);
    if (current === hitElement && isInteractiveElement(hitElement)) return null;

    return hitElement || document.documentElement;
  }
  function accessibleName(element) {
    const labelledBy = String(element?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => element.ownerDocument?.getElementById(id)?.textContent || "")
      .join(" ");
    const heading = element?.querySelector?.("h1,h2,h3,h4,h5,h6")?.textContent || "";
    return String(
      element?.getAttribute?.("aria-label") ||
      labelledBy ||
      heading ||
      element?.getAttribute?.("title") ||
      ""
    ).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  function describeHitTarget(element) {
    let modal = element;
    while (modal) {
      if (
        modal.getAttribute?.("role") === "dialog" ||
        modal.getAttribute?.("aria-modal") === "true"
      ) {
        const name = accessibleName(modal);
        return name ? 'dialog "' + name.replaceAll('"', '\\"') + '"' : "dialog";
      }
      modal = composedParent(modal);
    }
    const tag = String(element.tagName || "unknown").toLowerCase();
    const id = element.id
      ? ' id="' + String(element.id).slice(0, 80).replaceAll('"', '&quot;') + '"'
      : "";
    const role = element.getAttribute?.("role")
      ? ' role="' + String(element.getAttribute("role")).slice(0, 80).replaceAll('"', '&quot;') + '"'
      : "";
    const href = tag === "a" && element.hasAttribute?.("href")
      ? ' href="' + String(element.getAttribute("href")).slice(0, 120).replaceAll('"', '&quot;') + '"'
      : "";
    return "<" + tag + id + role + href + ">";
  }
`;
