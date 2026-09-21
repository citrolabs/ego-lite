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

A dialog can outlive the `ego-browser nodejs` invocation that opened it. The
SDK keeps dialog state per process, and while a dialog is open Chromium does
not answer renderer commands, including `Page.enable`. The next invocation
therefore cannot discover the dialog and every command it sends times out.
Ego Lite 0.5.2.2 does not meet this requirement yet: in local runs the dialog
was dismissed when the invocation exited, and sometimes the TaskSpace also
moved to user control. In the field, the dialog stayed open and the next
invocation timed out. When an invocation exits with a dialog open, the bridge
must:

- keep the dialog open and the TaskSpace Agent-owned;
- report the open dialog to the next session that attaches to the Page, for
  example by emitting `Page.javascriptDialogOpening` after `Page.enable`.

Acceptance: trigger each JavaScript dialog from a real Page click, verify that
the TaskSpace remains Agent-owned, accept a prompt with `promptText: "agent"`,
dismiss a confirm, accept an alert, and verify the returned values and opening
and closing events. Also set files on an intercepted file input whose change
handler opens a confirm, then accept it while `DOM.setFileInputFiles` is still
pending. For `beforeunload`, verify that the opening event and action receipt
arrive before choosing whether navigation may continue. Separately verify that
location, camera, and device prompts still transfer control to the user.
