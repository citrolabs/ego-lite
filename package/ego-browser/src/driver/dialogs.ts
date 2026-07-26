import { cdp } from "../cdp-eval.js";
import {
  ensureSession,
  isBrowserRuntime,
  pendingDialog,
  waitForBrowserEvent,
} from "../browser-runtime.js";
import { state } from "../state.js";

type DialogInfo = {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
};

type WaitForDialogOptions = {
  timeout?: number;
};

type DialogOpeningEvent = {
  method: "Page.javascriptDialogOpening";
  params?: {
    type?: string;
    message?: string;
    url?: string;
    defaultPrompt?: string;
  };
};

function formatDialog(params): DialogInfo | null {
  if (!params) {
    return null;
  }
  const info: DialogInfo = {
    type: params.type,
    message: params.message ?? "",
    url: params.url ?? "",
  };
  if (params.defaultPrompt !== undefined) {
    info.defaultPrompt = params.defaultPrompt;
  }
  return info;
}

/**
 * Return the currently pending JavaScript dialog, if any.
 * @returns {Promise<{type:string,message:string,url:string,defaultPrompt?:string}|null>}
 */
export async function dialog() {
  if (isBrowserRuntime()) {
    await ensureSession();
  }
  return formatDialog(pendingDialog());
}

/**
 * Accept the pending JavaScript dialog.
 * @param {string} [promptText] Optional prompt input for prompt dialogs.
 * @returns {Promise<void>}
 */
export async function acceptDialog(promptText?) {
  const params: any = { accept: true };
  if (promptText !== undefined) {
    params.promptText = promptText;
  }
  await cdp("Page.handleJavaScriptDialog", params);
}

/**
 * Dismiss the pending JavaScript dialog.
 * @returns {Promise<void>}
 */
export async function dismissDialog() {
  await cdp("Page.handleJavaScriptDialog", { accept: false });
}

/**
 * Wait for a JavaScript dialog to open.
 * @param {{timeout?: number}} [options] Timeout in milliseconds.
 * @returns {Promise<{type:string,message:string,url:string,defaultPrompt?:string}>}
 */
export async function waitForDialog(options: WaitForDialogOptions = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  if (isBrowserRuntime()) {
    await ensureSession();
  }
  const existing = formatDialog(pendingDialog());
  if (existing) {
    return existing;
  }
  const event = (await waitForBrowserEvent(
    (evt) => evt?.method === "Page.javascriptDialogOpening",
    timeout,
  )) as DialogOpeningEvent;
  return formatDialog(event?.params || pendingDialog());
}
