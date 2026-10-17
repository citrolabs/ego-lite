# Embedded SDK host requirements

## Disposal

When Ego Lite unloads or replaces an embedded ego-browser Node context, it
should call and await the module's exported `disposeEgoSdk()` function before
destroying that context.

The function rejects unfinished CDP requests, clears Page/session state, and
removes `onCDPMessage` and `onSendCDPMessageError` only when they are still
owned by that SDK instance. This prevents native code from retaining callbacks
into a discarded JavaScript context.

No new binding method is required. The host only needs to honor the module
lifecycle hook. Older SDK builds without `disposeEgoSdk` may be unloaded as
before.

Acceptance: load the SDK, complete one CDP command, leave another command
pending, call `disposeEgoSdk()`, then verify that the pending command rejects
and both native callback slots are empty before the Node context is destroyed.

## Syntax diagnostics

The `ego-browser nodejs` host compiles the heredoc before the embedded SDK can
inspect it. When compilation fails, report the message, one-based line and
column, and the corresponding source line. The direct JavaScript entry point
already provides this diagnostic, but it cannot recover source location after
the host has reduced the failure to a generic `node:internal/vm` stack.

No new Agent API is needed. The host may either pass the uncompiled source to
the SDK executor or format the V8 compile error itself.

Acceptance: run a heredoc containing an invalid token on line 4 and verify that
stderr identifies line 4, points to the token, and prints the source line.
