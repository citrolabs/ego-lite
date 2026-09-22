---
description: Run ego-browser scripts from Windows PowerShell or cmd, where heredoc does not exist. Read before the first script in those shells, or when a script fails to parse.
---

# Run scripts from Windows PowerShell or cmd

Keep the whole task in a UTF-8 `.mjs` file and load that file instead of
passing the script inline.

## PowerShell

PowerShell has no heredoc, and Windows PowerShell 5.1 drops the double quotes
inside an argument when it calls a native program, which splits the script into
several arguments. Do not pass a script that contains double quotes or spans
several lines to `-e`. Write it to a UTF-8 `.mjs` file instead and evaluate an
ASCII-only one-line entry point, which needs no double quotes of its own:

```powershell
ego-browser nodejs -e "await import('file:///C:/Users/<name>/ego/task.mjs')"
```

The imported module runs with the same helpers and `console` as an inline
script, so the whole task belongs in the `.mjs` file. Use forward slashes in the
`file:///` URL. Non-ASCII content such as Chinese text must stay inside the
file: never put it in a `-e` argument.

Do not pipe the file in with `Get-Content`. Windows PowerShell 5.1 reads a UTF-8
file as ANSI and sends ASCII to native programs, which corrupts non-ASCII text
and truncates strings. PowerShell has no `<` input redirection either.

## cmd

cmd has no heredoc, but it does support input redirection, so it can run the
same `.mjs` file directly:

```bat
ego-browser nodejs < C:\Users\<name>\ego\task.mjs
```

## When the script fails to parse

`SyntaxError: await is only valid in async functions and the top level bodies of
modules` almost always means the shell damaged the script before Node received
it; top-level `await` itself is supported. Do not wrap the code in an async
IIFE, open a new task space, or resend the same command. Switch to the `.mjs`
file form above.
