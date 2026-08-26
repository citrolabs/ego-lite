# Native JavaScript dialog requirement

Ego Lite 0.5.0.12 keeps page-authored `alert`, `confirm`, and `prompt` dialogs
under Agent control, including a confirm opened by a file input change handler.
The real-browser regression covers these paths without a takeover or recovery
step.

`beforeunload` remains outstanding. In 0.5.0.12, navigation proceeds without a
dialog event even after a trusted click and sticky user activation. The desired
behavior is to keep the dialog under Agent control and report it through the
same Page API.

No page-authored dialog may change TaskSpace ownership or report
`EGO_TASK_SPACE_USER_IN_CONTROL` with
`fallback_site_dialog_required_notice`.

No new binding is required. The existing CDP bridge must:

- forward `Page.javascriptDialogOpening` and
  `Page.javascriptDialogClosed` on the Page session;
- accept `Page.handleJavaScriptDialog` on that session while the dialog is
  open, even when the triggering command is still pending;
- preserve the dialog type, message, URL, prompt default, and supplied
  `promptText`.

Permission prompts and device choosers must continue to transfer control to
the user.

Acceptance: trigger each JavaScript dialog from a real Page click, verify that
the TaskSpace remains Agent-owned, accept a prompt with `promptText: "agent"`,
dismiss a confirm, accept an alert, and verify the returned values and opening
and closing events. Also set files on an intercepted file input whose change
handler opens a confirm, then accept it while `DOM.setFileInputFiles` is still
pending. For `beforeunload`, verify that the opening event and action receipt
arrive before choosing whether navigation may continue. Separately verify that
location, camera, and device prompts still transfer control to the user.
