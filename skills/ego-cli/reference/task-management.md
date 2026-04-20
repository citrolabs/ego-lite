# Task Management

Route browser commands to Ego-managed tasks with `--task-id=<task-id>`.
When `--task-id` is omitted, commands run inside the implicit `default` task.

In practice, each task keeps its own browser state, including cookies,
storage, tabs, and snapshot refs.

**Related**: [authentication.md](authentication.md) for login patterns,
[SKILL.md](../SKILL.md) for the core loop.

## Contents

- [Task Model](#task-model)
- [Default Task](#default-task)
- [Inspect Tasks](#inspect-tasks)
- [Route Commands to a Task](#route-commands-to-a-task)
- [Complete or Close a Task](#complete-or-close-a-task)
- [Task-Scoped State Persistence](#task-scoped-state-persistence)
- [Common Patterns](#common-patterns)
- [Best Practices](#best-practices)

## Task Model

There are two ways to work:

- Run browser commands directly with no `--task-id`. This uses the implicit
  `default` task.
- When Ego has created service-managed tasks, find the task id with
  `ego-cli task list`, then pass `--task-id=<task-id>` on every browser
  command you want to route to that task.

Use `ego-cli task ...` to manage tasks themselves. Use
`ego-cli --task-id=<task-id> <command>` to run browser commands inside a
specific task.

## Default Task

When `--task-id` is omitted, commands run in the implicit `default` task:

```bash
ego-cli open https://example.com
ego-cli snapshot -i
ego-cli click @e2
ego-cli close
```

This is the simplest workflow when you do not need to coordinate with
service-managed tasks.

## Inspect Tasks

List the tasks owned by the Ego service:

```bash
ego-cli task list
```

Typical next step:

```bash
ego-cli --task-id=s1 snapshot -i
```

## Route Commands to a Task

Once you know the task id, keep passing it consistently:

```bash
ego-cli --task-id=s1 open https://app.example.com
ego-cli --task-id=s1 snapshot -i
ego-cli --task-id=s1 fill @e3 "user@example.com"
ego-cli --task-id=s1 click @e5
```

Tasks are isolated from one another. Refs from task `s1` do not apply to task
`s2`, and tabs or cookies created in one task are not shared with another.

## Complete or Close a Task

Use the task command group when the work is finished:

```bash
ego-cli task complete s1
ego-cli task close s2
```

- `task complete` marks the task done.
- `task close` stops the task and releases its browser session.

Use `close` by itself only for the current task's browser. Use
`task close <task-id>` when you mean to close a specific service-managed task.

## Task-Scoped State Persistence

State files still work the same way, but they apply to the task you run the
command in:

```bash
ego-cli --task-id=s1 state save /path/to/auth-state.json
ego-cli --task-id=s1 state load /path/to/auth-state.json
```

If you save state from one task and want to restore it later, load it into the
same task you intend to keep working in.

## Common Patterns

### Resume a service-managed task

```bash
ego-cli task list
ego-cli --task-id=s1 snapshot -i
ego-cli --task-id=s1 get url
```

### Reuse login state inside a task

```bash
STATE_FILE="/tmp/auth-state.json"

ego-cli --task-id=s1 state load "$STATE_FILE"
ego-cli --task-id=s1 open https://app.example.com/dashboard
ego-cli --task-id=s1 snapshot -i
```

### Compare two service-managed tasks

```bash
ego-cli task list
ego-cli --task-id=s1 screenshot /tmp/task-s1.png
ego-cli --task-id=s2 screenshot /tmp/task-s2.png
```

## Best Practices

### 1. Treat task ids as routing keys

Keep the same `--task-id` on every related command. Mixing default-task
commands with `--task-id=s1` commands is a common source of confusion.

### 2. Re-snapshot per task

Refs are local to the task and the current page state. If you switch tasks,
run `snapshot -i` again before using `@eN` refs.

### 3. Finish tasks explicitly

When the service-managed work is done, call `ego-cli task complete <task-id>`
or `ego-cli task close <task-id>` instead of leaving tasks hanging around.

### 4. Handle state files securely

```bash
echo "*.auth-state.json" >> .gitignore
rm /tmp/auth-state.json
```
