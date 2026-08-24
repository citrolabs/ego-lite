# Native JavaScript dialog requirement

Page-authored `alert`, `confirm`, `prompt`, and `beforeunload` dialogs must stay
under Agent control. They must not change TaskSpace ownership or report
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
and closing events. Separately verify that location, camera, and device prompts
still transfer control to the user.
