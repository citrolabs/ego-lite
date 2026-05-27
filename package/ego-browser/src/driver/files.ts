import { cdp } from "../cdp-eval.js";

/**
 * Set files on a CSS-selected file input.
 * @param {string} selector CSS selector for an input[type=file].
 * @param {string|string[]} path Absolute file path or paths to upload.
 * @returns {Promise<void>}
 */
export async function uploadFile(selector, path) {
  const doc = await cdp("DOM.getDocument", { depth: -1 });
  const nodeId = (await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector })).nodeId;
  if (!nodeId) {
    throw new Error(`no element for ${selector}`);
  }
  await cdp("DOM.setFileInputFiles", { files: Array.isArray(path) ? path : [path], nodeId });
}
