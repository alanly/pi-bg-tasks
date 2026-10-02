# pi-bg-tasks

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that lets
the agent run shell commands as **non-blocking background tasks**.

- **bg_run** starts a command via `bash -lc` and returns immediately. The
  session continues while the command runs.
- **bg_wait** blocks until a task ends (honors the abort signal and a wait
  timeout; the task keeps running either way).
- **bg_status** lists tasks: status, runtime, exit code, output preview.
- **bg_output** reads the captured output tail (stdout / stderr / combined).
- **bg_stop** stops a task: SIGTERM to the process group, SIGKILL after 2 s.

When a task ends and no `bg_wait` call is active, Pi sends the agent a
`bg-task-complete` alert (exit code, duration, output tail) that triggers a
new turn — so long-running builds and tests can continue in the background
without polling.

A footer status line appears **only while tasks exist**:

```
🧵 bg: 2 running · 1 done · 1 failed
```

Done (exit 0) shows green, failed (nonzero exit, signal, or timeout) shows red.

## Notes

- Each stream keeps only the last 64 KiB in memory (`totalBytes` and a
  `truncated` flag are tracked). Use `logFile` on `bg_run` to tee the full
  output to a file.
- Processes run in their own process group; kills stop the full process tree.
- Tasks are killed at session shutdown (SIGTERM, then SIGKILL after 2 s).
- In-memory state only: no crash survival. After a restart the registry is
  empty and running tasks are gone.
- `bash -lc` runs the login shell, so user profile setup (conda, PATH, nvm)
  applies to background tasks. Profile startup can take a few hundred
  milliseconds before the command string starts.
- Platforms: macOS and Linux only. The process-group functions are not
  reliable on Windows.

## Install

Dev checkout (like this repo):

```jsonc
// ~/.pi/agent/settings.json
{
  "extensions": ["extensions/pi-bg-tasks/index.ts"]
}
```

Symlink the repo into `~/.pi/agent/extensions/pi-bg-tasks`, or reference an
absolute path. Reload Pi after a change.

## Develop

```sh
npm install
npm test        # vitest: unit + integration (real processes)
npm run typecheck
```

See `DESIGN.md` for the full technical design (ASD-STE100).
