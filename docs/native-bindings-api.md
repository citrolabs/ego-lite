# Ego Lite Native Bindings API Reference

This document describes the low-level `globalThis.ego` API injected into the
`ego-browser nodejs` environment by the installed Ego Lite application.

These bindings are provided by Ego Lite, not implemented by this repository.
Their availability is determined by the installed Ego Lite build and is
independent of the Git tag or branch used to build the local `ego-browser`
runtime.

The runtime in this repository consumes these bindings and may expose only a
subset of them through its higher-level helpers. Agent automation should
normally follow `skills/ego-browser/SKILL.md`; runtime maintainers may access
`globalThis.ego` directly when working with the native bridge.

## Runtime Model

Most methods return a `Promise` and route work to the browser-side
`NodeClient`. Promise results are converted from browser-side `base::Value`
objects, so result shapes can follow the command implementation that handled the
request.

Task-scoped APIs operate on the current task context. Select that context with
`ego.useTaskSpace(id)` inside the script. `id` is the numeric task-space id
reported by `ego.createTaskSpace()`, `ego.claimTaskSpace()`, or
`ego.listTaskSpaces()`. Selecting a task only updates the current Node
invocation; it does not create, claim, or validate the browser-side task space.

Profiles are selected when a task space is created, not through
`ego.useTaskSpace()`. Call `ego.listProfiles()` to discover the available
profiles, then pass the selected profile's `id` to
`ego.createTaskSpace(name, profileId)`. Existing task-scoped APIs continue to
operate on the profile that owns the selected task space.

Task-space result objects currently expose both a numeric locator and a
user-visible name:

```js
{
  id: 7,                    // numeric unique task-space locator
  taskId: 'checkout-flow',  // same value as name
  name: 'checkout-flow',    // user-visible display name
}
```

Use `id` when calling APIs that operate on an existing task space. `taskId` is a
display-name compatibility field and should not be used as a locator.

If no task context is available, task-scoped APIs resolve to an error object or
reject depending on the underlying operation. Regular task commands usually
resolve an object like
`{ error: "Task space not selected", error_code: "EGO_TASK_SPACE_NOT_SELECTED" }`;
`ego.snapshot()` rejects with an `Error` whose `error_code` property is set.

When a task has been handed off to the user, browser-mutating automation calls
are blocked until the agent takes the task back. The affected APIs are
`ego.createTab()`, `ego.listTabs()`, `ego.snapshot()`, `ego.closeTaskSpace()`,
`ego.completeTaskSpace()`, `ego.animationHighlightMouseToPosition()`,
`ego.setAgentTaskState()`, and raw CDP sends through `ego.sendCDPMessage()`.
Most of these APIs resolve an error object with `error` and `error_code` fields;
`ego.snapshot()` rejects with an `Error` containing `error_code`; raw CDP sends
report the failure through `ego.onSendCDPMessageError`.

## Error Codes

Browser-side failures expose a stable `error_code` in addition to a human-readable
message. Promise-returning APIs use one of these shapes:

```js
{ error: 'Task space not selected', error_code: 'EGO_TASK_SPACE_NOT_SELECTED' }
```

or, for rejected operations:

```js
try {
  await ego.snapshot();
} catch (error) {
  console.log(error.message);
  console.log(error.error_code);
}
```

Argument validation failures throw `TypeError` with
`error_code: 'EGO_INVALID_ARGUMENT'`.

Known error codes:

```text
EGO_BROWSER_UNAVAILABLE
EGO_CDP_CHANNEL_UNAVAILABLE
EGO_CDP_SEND_FAILED
EGO_INVALID_ARGUMENT
EGO_INVALID_RESULT_PAYLOAD
EGO_OPERATION_FAILED
EGO_PROFILE_NOT_FOUND
EGO_RESULT_CONVERSION_FAILED
EGO_SNAPSHOT_FAILED
EGO_TASK_HOST_DISCONNECTED
EGO_TASK_SPACE_INACTIVE
EGO_TASK_SPACE_NOT_FOUND
EGO_TASK_SPACE_NOT_SELECTED
EGO_TASK_SPACE_UNAVAILABLE
EGO_TASK_SPACE_USER_IN_CONTROL
EGO_WEB_CONTENTS_UNAVAILABLE
```

All async callbacks are bounced through the Node event loop before JS is
invoked. Scripts can safely `await` these APIs and allow the process to exit
after pending requests settle.

## Browser Version

### `await ego.getBrowserVersion()`

Returns the installed Ego Lite version and whether its updater has an available
release. This method is not task-scoped and does not start an update.

```js
{
  currentVersion: '0.5.0.5',
  updateAvailable: false,
}
```

Older Ego Lite builds may not expose this method. Callers should treat a missing
method, a failed request, or an invalid result as unavailable update status.

## Task Context

### `ego.useTaskSpace(id)`

Selects the task context for subsequent task-scoped helper calls in the current
Node invocation. This is a synchronous local selection only.

```js
const id = ego.useTaskSpace(task.id);
```

Arguments:

```text
id: number
```

Returns the selected `id` synchronously.

Throws `TypeError` when `id` is missing, not a number, or extra arguments are
provided. The thrown error has `error_code: 'EGO_INVALID_ARGUMENT'`.

Use `ego.createTaskSpace(name)` to create a new agent-owned task space. Regular
Spaces created by the user are returned by `ego.listTaskSpaces()` with
`ownership: 'user'`. Pass their numeric `id` to
`ego.claimTaskSpace(id, name?)` before selecting them.

## Profiles

Profiles determine which browser identity, cookies, storage, and login state a
new task space inherits. Profile selection only applies when creating the task
space. After creation, select the returned task-space `id` with
`ego.useTaskSpace(task.id)` as usual.

Profile APIs are available when the installed Ego Lite build exposes them,
even if the checked-out repository runtime does not yet provide equivalent
higher-level helper methods.

### `await ego.listProfiles()`

Lists the profiles that may be used by `ego.createTaskSpace()`.

```js
const result = await ego.listProfiles();
for (const profile of result.profiles) {
  console.log(profile.id, profile.name, profile.isDefault);
}
```

Arguments: none.

Returns:

```js
{
  profiles: [
    {
      id: 'Profile 2',
      name: 'Work',
      isDefault: false,
    },
    {
      id: 'Default',
      name: 'Personal',
      isDefault: true,
    },
  ],
}
```

Field meanings:

```text
id:
  Locator accepted by ego.createTaskSpace(name, profileId), for example
  "Default" or "Profile 2".

name:
  User-visible profile name. It may be duplicated and is not a locator.

isDefault:
  True for the profile selected when profileId is omitted. This does not
  necessarily mean that id is "Default".
```

The result contains available regular profiles. The internal Ego authentication
profile is not exposed.

Throws `TypeError` when any argument is passed. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

To create a task space with a profile, pass `profile.id` to
`ego.createTaskSpace(name, profileId)`. See the Task Spaces section for the
complete call and error handling.

## Tabs

### `await ego.createTab(url)`

Creates a tab in the current task space.

```js
const tab = await ego.createTab('https://example.com/');
console.log(tab.targetId);
```

Arguments:

```text
url: string
```

Returns a browser-side result object. Current task implementations return a
tab descriptor containing at least `targetId` when creation succeeds.

Throws `TypeError` when `url` is missing or not a string.
The thrown error has `error_code: 'EGO_INVALID_ARGUMENT'`.

### `await ego.listTabs()`

Lists tabs in the current task space.

```js
const result = await ego.listTabs();
for (const tab of result.tabs) {
  console.log(tab.index, tab.title, tab.url, tab.active);
}
```

Arguments: none.

Typical result:

```js
{
  tabs: [
    {
      index: 0,
      targetId: '...',
      url: 'https://example.com/',
      title: 'Example',
      active: true,
    },
  ],
}
```

If the current task has been handed off to the user, the promise resolves to an
error object:

```js
{
  error: 'The task is under user control...',
  error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
}
```

`error_code` is `'EGO_TASK_SPACE_USER_IN_CONTROL'`. For this code, `error` is a
stable reason key rather than display text. Current keys are:

```text
notifications
location
camera
microphone
pan_tilt_zoom_microphone
midi
bluetooth
usb
serial
hid
protocol_handler
manual_takeover
```

For example, a location prompt returns:

```js
{
  error: 'location',
  error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
}
```

Callers should use `error_code` to identify the control boundary, then use the
reason key to choose guidance. Unknown reason keys must fall back to generic
user-control guidance.

Page-authored JavaScript dialogs must not use this user-control path; see
[Native JavaScript dialog requirement](native-javascript-dialog-requirement.md).

## Snapshot

### `await ego.snapshot(options?)`

Captures a structured snapshot for the current task space.

```js
const snapshot = await ego.snapshot({
  scope: 'only_within_viewport',
  includeActionMarks: true,
  interactiveOnly: true,
  includeStableLocator: true,
  maxResultLength: 4000,
});

console.log(snapshot.content);
console.log(snapshot.refs);
```

Arguments:

```text
options?: object
```

Supported options:

```text
scope:
  'full_page'            Capture the full page. This is the default.
  'only_within_viewport' Capture only the viewport.

includeActionMarks: boolean
  Include action markers in the textual snapshot.

interactiveOnly: boolean
  Limit output to interactive elements.

includeStableLocator: boolean
  Include reusable locator hints on refs when available.

maxResultLength: number
  Maximum result content length. Zero or omitted means unlimited.
```

Result:

```js
{
  content: '...',
  refs: [
    {
      backendNodeId: 17,
      role: 'button',
      name: 'Continue',
      loc: 'role:button[name=Continue]', // only when available
    },
  ],
}
```

When no stable, unique locator is available, omit `loc` from both `refs` and
the textual snapshot. Do not return `unstable` or `ambiguous` as locator values.

If the browser side reports a snapshot error, the promise rejects with an
`Error`. The `message` contains the human-readable error, and `error_code`
contains a stable code such as `EGO_SNAPSHOT_FAILED`,
`EGO_TASK_SPACE_NOT_SELECTED`, `EGO_TASK_SPACE_NOT_FOUND`,
`EGO_TASK_SPACE_USER_IN_CONTROL`, or `EGO_WEB_CONTENTS_UNAVAILABLE`.

## Task Spaces

### `await ego.listTaskSpaces()`

Lists Agent task spaces and regular user-created Spaces that are available to
the native task-space bridge. Listing is read-only: it does not select or claim
a Space.

```js
const spaces = await ego.listTaskSpaces();
for (const space of spaces.taskSpaces) {
  console.log(space.id, space.name, space.ownership);
}
```

Arguments: none.

Returns:

```js
{
  taskSpaces: [
    {
      taskId: 'research',
      id: 3,
      name: 'research',
      createdBy: 'user',
      ownership: 'user',
      profileId: 'Default',
      profileName: 'Work',
      recentTabTitles: ['Project notes', 'Reference'],
    },
    {
      taskId: 'checkout-flow',
      id: 7,
      name: 'checkout-flow',
      createdBy: 'agent',
      ownership: 'agent',
      recentTabTitles: ['Checkout', 'Cart'],
    },
  ],
}
```

`id` is the locator for `ego.claimTaskSpace()` and other task-space APIs.
`name` and `taskId` are display values and may be duplicated. A regular Space
created in the Ego Lite UI has `createdBy: 'user'` and `ownership: 'user'`.
`recentTabTitles` may help the caller identify the intended Space without
claiming it.

Throws `TypeError` when any argument is passed.
The thrown error has `error_code: 'EGO_INVALID_ARGUMENT'`.

### `await ego.createTaskSpace(name, profileId?)`

Creates an agent-owned task space by name, optionally using a specific profile.

```js
const { profiles } = await ego.listProfiles();
const profile = profiles.find(item => !item.isDefault) ?? profiles[0];
if (!profile) {
  throw new Error('No available profile');
}

const taskName = `profile-demo-${Date.now()}`;
const task = await ego.createTaskSpace(taskName, profile.id);
if (task.error) {
  throw new Error(`${task.error} (${task.error_code})`);
}
ego.useTaskSpace(task.id);
console.log(JSON.stringify({ profile, task }, null, 2));
```

Arguments:

```text
name: string, non-empty
profileId?: string
  Unique profile id returned by ego.listProfiles(). If omitted, empty, or
  "default", the currently active/last-used regular profile is selected.
```

Returns:

```js
{
  taskId: 'checkout-flow',
  id: 7,
  name: 'checkout-flow',
}
```

Throws `TypeError` when `name` is missing, not a string, or empty; when
`profileId` is present but not a string; or when extra arguments are provided.
The thrown error has `error_code: 'EGO_INVALID_ARGUMENT'`.

If `profileId` does not identify an available profile, the promise resolves to:

```js
{
  error: 'Profile not found',
  error_code: 'EGO_PROFILE_NOT_FOUND',
}
```

If the browser cannot create a task space, the promise resolves to an error
object:

```js
{
  error: 'No active browser',
  error_code: 'EGO_BROWSER_UNAVAILABLE',
}
```

### `await ego.claimTaskSpace(id, name?)`

Claims a Space returned by `ego.listTaskSpaces()` and turns it into an
agent-owned task space. This includes regular Spaces created by the user. Pass
`name` to rename the Space while claiming it.

```js
const spaces = await ego.listTaskSpaces();
const checkout = spaces.taskSpaces.find(space => space.name === 'checkout-flow');
const task = await ego.claimTaskSpace(checkout.id, 'checkout-flow');
ego.useTaskSpace(task.id);
```

Arguments:

```text
id: number
name?: string
```

Returns:

```js
{
  taskId: 'checkout-flow',
  id: 7,
  name: 'checkout-flow',
}
```

Claiming a regular user Space keeps its browser profile, tabs, active tab, and
numeric `id`; it does not create a replacement Space. The caller must have the
user's approval before taking ownership.

Throws `TypeError` when `id` is missing or not a number, when `name` is present
but not a string, or when extra arguments are provided. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

If the space does not exist or cannot be claimed, the promise resolves to an
error object. Error messages identify the numeric id that was used for lookup:

```js
{
  error: 'Task space not found: 7',
  error_code: 'EGO_TASK_SPACE_NOT_FOUND',
}
```

`claimTaskSpace()` does not select the task context by itself. Call
`ego.useTaskSpace(task.id)` after a successful claim before using task-scoped
helpers.

### `await ego.closeTaskSpace()`

Closes the current task space and removes the task-owned browser state.

```js
await ego.closeTaskSpace();
```

Arguments: none.

Returns a browser-side status value, currently a string such as
`"<id> task space closed."` on success, or an error object if the task does
not exist. Error objects include `error` and `error_code`.

Throws `TypeError` when any argument is passed. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

### `await ego.completeTaskSpace()`

Completes the current task space by removing agent task state while leaving the
Space open for the user. It remains discoverable through
`ego.listTaskSpaces()` under the same numeric `id` with user ownership.

```js
await ego.completeTaskSpace();
```

Arguments: none.

Returns a browser-side status value, currently a string such as
`"<id> task space completed."` on success, or an error object if the task
does not exist. Error objects include `error` and `error_code`.

Throws `TypeError` when any argument is passed. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

## Task Control

### `await ego.handOffTaskSpace()`

Transfers the current task space to user control.

```js
await ego.handOffTaskSpace();
```

Arguments: none.

Returns the browser-side status value from the handoff operation.
Current implementations return a string such as
`"<id> has been handed off to the user."`.

Throws `TypeError` when any argument is passed. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

### `await ego.takeOverTaskSpace()`

Returns the current task space to agent control.

```js
await ego.takeOverTaskSpace();
```

Arguments: none.

Returns the browser-side status value from the takeover operation.
Current implementations return a string such as
`"<id> has been taken over by the agent."`.

Throws `TypeError` when any argument is passed. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

### `await ego.setAgentTaskState(state)`

Updates the user-visible agent progress text for the current task space.

```js
await ego.setAgentTaskState('Waiting for checkout page');
```

Arguments:

```text
state: string
```

Returns the browser-side status value from the task state update. Current
implementations return a string such as `"<id> state updated."`.

Throws `TypeError` when `state` is missing, not a string, or extra arguments are
provided. The thrown error has `error_code: 'EGO_INVALID_ARGUMENT'`.

## UI Helpers

### `await ego.animationHighlightMouseToPosition(x, y)`

Shows an animated highlight at the given screen position for the current task
space.

```js
await ego.animationHighlightMouseToPosition(120, 240);
```

Arguments:

```text
x: number
y: number
```

Returns the browser-side status value from the highlight operation. Current
implementations return a string such as `"<id> mouse highlight shown."`.

Throws `TypeError` when either coordinate is missing, not a number, or extra
arguments are provided. The thrown error has
`error_code: 'EGO_INVALID_ARGUMENT'`.

## Chrome DevTools Protocol

### `ego.sendCDPMessage(message)`

Sends a raw CDP message through the Node CDP channel. The message must already
be JSON-encoded. The current task must be selected with `ego.useTaskSpace(id)`,
and its ownership must be `agent`. If the task is missing, inactive, delegated
to the user, or unavailable, the message is not sent and
`ego.onSendCDPMessageError` receives the reconstructed error message and code.

```js
const task = await ego.createTaskSpace('cdp-demo');
ego.useTaskSpace(task.id);
ego.sendCDPMessage(JSON.stringify({
  id: 1,
  method: 'Runtime.enable',
}));
```

Arguments:

```text
message: string
```

Returns `undefined`.

Throws `TypeError` when `message` is missing or not a string, or when the CDP
channel is not connected. The thrown error has `error_code` set to
`EGO_INVALID_ARGUMENT` for invalid arguments or `EGO_CDP_CHANNEL_UNAVAILABLE`
when the channel is missing.

Notes:

```text
Raw CDP user-control checks use the task selected by ego.useTaskSpace(id).
If no task has been selected, the send fails with EGO_TASK_SPACE_NOT_SELECTED.
```

### `ego.onCDPMessage`

Property used to receive raw CDP messages from the browser side.

```js
ego.onCDPMessage = message => {
  const event = JSON.parse(message);
  console.log(event.method);
};
```

Assign a function to receive messages. Assigning any non-function value clears
the callback. Incoming messages are delivered asynchronously through the Node
event loop.

### `ego.onSendCDPMessageError`

Property used to receive local send failures for `ego.sendCDPMessage()`.

```js
ego.onSendCDPMessageError = (message, error_code) => {
  console.error(message, error_code);
};

const task = await ego.createTaskSpace('cdp-version');
ego.useTaskSpace(task.id);
ego.sendCDPMessage(JSON.stringify({
  id: 2,
  method: 'Browser.getVersion',
}));
```

Arguments delivered to the callback:

```text
message: string
error_code: string
```

The callback does not include the reason key. A user-control send failure
therefore identifies the control boundary, not the permission that caused it.

Assign a function to receive errors. Assigning any non-function value clears the
callback. Errors are delivered asynchronously through the Node event loop.

This callback is used for failures that happen before the message reaches CDP,
including:

```text
- the task is currently under user control
- no task space has been selected
- the selected task space does not exist
- the selected task space has not been claimed by the agent
- the browser-side CDP agent host is no longer available
```

User-control example:

```js
const task = await ego.createTaskSpace('user-control-demo');
ego.useTaskSpace(task.id);
await ego.handOffTaskSpace();

const result = await ego.createTab('https://example.com/');
console.log(result.error);
console.log(result.error_code); // "EGO_TASK_SPACE_USER_IN_CONTROL"

try {
  await ego.snapshot();
} catch (error) {
  console.log(error.message);
  console.log(error.error_code); // "EGO_TASK_SPACE_USER_IN_CONTROL"
}

ego.onSendCDPMessageError = (message, error_code) => {
  console.log(message);
  console.log(error_code); // "EGO_TASK_SPACE_USER_IN_CONTROL"
};
ego.sendCDPMessage(JSON.stringify({
  id: 1,
  method: 'Browser.getVersion',
}));

await ego.takeOverTaskSpace();
```

## Complete Example

```js
const { profiles } = await ego.listProfiles();
const profile = profiles.find(item => !item.isDefault) ?? profiles[0];
if (!profile) {
  throw new Error('No available profile');
}

const task = await ego.createTaskSpace('checkout-flow', profile.id);
if (task.error) {
  throw new Error(`${task.error} (${task.error_code})`);
}
ego.useTaskSpace(task.id);

await ego.createTab('https://example.com/');
await ego.setAgentTaskState('Reading page');

const snapshot = await ego.snapshot({
  scope: 'only_within_viewport',
  includeActionMarks: true,
  interactiveOnly: true,
});

console.log(snapshot.content);

await ego.completeTaskSpace();
```

## Native API Compatibility Notes

### Profile-aware task-space creation

- Added `ego.listProfiles()`, which returns available profiles as
  `{id, name, isDefault}`.
- `ego.createTaskSpace(name)` now accepts an optional profile locator:
  `ego.createTaskSpace(name, profileId?)`.
- Profile display names are not accepted as locators because they are not
  unique. Callers must pass the `id` returned by `ego.listProfiles()`.
- Omitting `profileId`, passing an empty string, or passing `"default"` selects
  the current default regular profile.
- Unknown profile ids resolve an error object with
  `error_code: 'EGO_PROFILE_NOT_FOUND'`.

### Task-space ids are numeric locators

- `ego.useTaskSpace(taskId)` changed to `ego.useTaskSpace(id)`.
  `id` is a numeric task-space locator returned by task-space APIs.

- `ego.claimTaskSpace(name)` changed to `ego.claimTaskSpace(id, name?)`.
  The first argument identifies an existing task space by numeric id. `name` is
  optional and renames the task space when provided.

- Task-space result objects now distinguish locator and display fields:

  ```js
  {
    id: 7,
    taskId: 'checkout-flow',
    name: 'checkout-flow',
  }
  ```

  Use `id` for API calls. `taskId` is currently the same value as `name` and is
  retained as a display-name compatibility field.

- Task-scoped examples now select task spaces with `task.id`, including
  `createTab`, `listTabs`, `snapshot`, `closeTaskSpace`,
  `completeTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`,
  `setAgentTaskState`, `animationHighlightMouseToPosition`, and raw CDP sends.

- Browser-side operation messages now identify task spaces by numeric id, for
  example `"<id> task space completed."`, `"<id> state updated."`, and
  `"Task space not found: <id>"`.

### Error codes

- Browser-side error results now include a stable `error_code` string.
- `ego.snapshot()` rejects with an `Error` whose `error_code` property is set.
- `ego.onSendCDPMessageError` receives `(message, error_code)`.
