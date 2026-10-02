# pi-bg-tasks: Technical Design

This document gives the technical design for the pi-bg-tasks extension. The
extension lets the Pi agent run shell commands as background tasks. A
background task does not block the session. The agent can check the task
state at any time. When a task ends, Pi sends the result to the agent. A
status line shows the task counts. The status line is visible only while
tasks exist.

Target: Pi 1.0.0 and later. All APIs in this document were verified against
the installed `@earendil-works/pi-coding-agent` 1.0.0. Verification file:
`dist/core/extensions/types.d.ts`.

Document standard: this document obeys the ASD-STE100 Simplified Technical
English rules where the rules apply to a design document. Code blocks, file
paths, and quoted tool text are not controlled prose.

## Abbreviations and terms

| Term | Meaning |
|---|---|
| API | application programming interface |
| JSON | JavaScript Object Notation |
| KiB | kibibyte (1024 bytes) |
| ms | millisecond |
| RPC | remote procedure call |
| TUI | terminal user interface |
| background task | a shell command that runs while the session continues |
| exit code | the number that a process returns when it ends |
| idempotent | safe to run more than once with the same result |
| waiter | a `bg_wait` call that blocks on a task |
| EOF | end of file |
| process group | the process and all of its child processes |

---

## 1. Requirements

| # | Requirement |
|---|---|
| R1 | The agent shall start a shell command as a background task. The session shall continue during the run. |
| R2 | The agent shall be able to wait for the end of a background task. |
| R3 | The agent shall be able to get the task state at any time. The state contains the status, the exit code, and the output. |
| R4 | When a task ends and no `bg_wait` call is active, Pi shall send an alert to the agent. The alert shall contain the result of the task. |
| R5 | Pi shall show a status line only while background tasks exist. The line shall show the count of tasks that run. It shall also show the count of tasks that ended. |

---

## 2. Architecture

The extension is one directory of TypeScript files. Pi loads the extension
with jiti. No build step is necessary.

```
pi-bg-tasks/
├── index.ts            # factory. Registers tools, renderers, and shutdown.
├── src/
│   ├── types.ts        # BgTask, TaskStatus, tool result shapes
│   ├── registry.ts     # task registry in memory and count queries
│   ├── process.ts      # process start, stream capture, exit handling
│   ├── alerts.ts       # completion message delivery
│   ├── statusline.ts   # footer text formatting
│   └── ringbuf.ts      # tail output buffer
├── tests/              # vitest unit and integration tests
├── package.json        # dev dependencies only
└── DESIGN.md
```

Initialization (`index.ts`):

```ts
export default function (pi: ExtensionAPI) {
  const registry = new TaskRegistry();
  const statusline = new StatusLine(registry);
  const alerts = new AlertDelivery(pi, registry);
  const processMgr = new ProcessManager({ registry, statusline, alerts });

  registerTools(pi, { registry, processMgr, statusline, alerts });
  pi.registerMessageRenderer(CT_BG_COMPLETE, renderCompleteMessage);
  // ctx is not a factory parameter. Capture it at session_start.
  pi.on("session_start", async (_event, ctx) => registry.captureContext(ctx));
  pi.on("session_shutdown", async () => processMgr.shutdownAll()); // idempotent
}
```

Obey the Pi lifecycle rules:

- Do not start processes or timers in the factory.
- Start a process only in the `execute()` function of a tool.
- Do the cleanup in the `session_shutdown` handler. The handler shall be
  idempotent.

Context rules:

- The factory gets only the `pi` object. `ctx` is a parameter of event
  handlers and of the tool `execute()` functions.
- The process exit handler runs outside these functions. It has no `ctx`
  parameter.
- Capture `ctx` in the `session_start` handler. Refresh the captured copy in
  each tool `execute()` call.
- Store the captured `ctx` in the registry. The alert code and the status
  line code use this copy.
- Pi fires `session_start` again after a session switch (new, resume, fork,
  reload). Thus the captured `ctx` stays fresh.

---

## 3. Core state

```ts
// src/types.ts
type TaskStatus = "running" | "exited";

interface BgTask {
  id: string;              // "bg-1", "bg-2", ... (per-session counter)
  name?: string;           // optional label from the model
  command: string;
  cwd: string;
  startedAt: number;       // Date.now()
  exitedAt?: number;
  status: TaskStatus;
  exitCode?: number | null; // null = the process was killed by a signal
  signal?: string;
  timedOut?: boolean;
  stdout: TailBuffer;      // keeps the last 64 KiB by default
  stderr: TailBuffer;
  proc?: ChildProcess;     // not present after exit
  exitPromise: Promise<void>; // created at spawn; the exit handler resolves it
  activeWaiters: number;   // more than 0 while a bg_wait call blocks on it
  delivered: boolean;      // the alert was already sent
  timeoutTimer?: NodeJS.Timeout;
}
```

TailBuffer is a string buffer with a fixed capacity. The buffer keeps only
the most recent N bytes. The default N is 64 KiB. The buffer also keeps a
`totalBytes` counter and a `truncated` flag. The append operation is
inexpensive. Commands that write much output, for example `npm run dev`,
cannot use an uncontrolled quantity of memory.

---

## 4. Tools

Pi registers all tools with `pi.registerTool`. Each tool uses a TypeBox
`Type.Object` schema. Import `Type` from the `typebox` virtual module of Pi.
Do not import `@sinclair/typebox`. The tools share the namespace `bg`. The
namespace description is "Background shell tasks".

All five tools use `executionMode: "sequential"`. The tools share the
registry in memory. `bg_wait` also changes the registry: it changes
`activeWaiters`. This is the Pi rule for tools that share mutable state in
memory.

### 4.1 `bg_run`: start a background task (R1)

```ts
const BgRunParams = Type.Object({
  command: Type.String({ description: "Shell command to run via bash -c" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
  name: Type.Optional(Type.String({ description: "Short label for the task" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Kill after this long; 0/omitted = no timeout" })),
  logFile: Type.Optional(Type.String({ description: "Tee full stdout+stderr to this file (tail buffer still kept)" })),
});
```

Procedure:

1. Spawn `bash -lc` with the command. Use `detached: true`. This starts a
   new process group. The group id is equal to the process id. Use
   `stdio: ["ignore", "pipe", "pipe"]`. The stdin is `ignore`. A command
   that reads stdin gets EOF at once.
2. Write the stdout and stderr streams into TailBuffers. Register the exit
   handler at once. The tool returns before the process ends.
3. If `logFile` is given, open the file in append mode. Also write the full
   output to that file. Append mode does not destroy the content when two
   tasks share one log file. Tell the model that it can read the file for the
   full history.
4. If `timeoutMs` is set, start a timer. The timer starts the kill sequence
   in section 6.
5. Return immediately. The result contains the task id, the status
   `running`, and a note about the automatic completion message.

The tool description explains the rules to the model: "Returns immediately.
You will be notified with the result when it finishes. Use bg_wait to block.
Use bg_status and bg_output to inspect."

### 4.2 `bg_wait`: block until the task ends (R2)

```ts
const BgWaitParams = Type.Object({
  id: Type.String(),
  timeoutMs: Type.Optional(Type.Number({ description: "Give up waiting after this long (task keeps running)" })),
});
```

Procedure:

0. If the task status is `exited`, return the result at once. Do not wait.
   This step prevents a deadlock on a task that already ended.
1. Increase `task.activeWaiters` by one. Then block on the promise that the
   spawn code stored on the task (`task.exitPromise`). The exit handler
   resolves this promise. The design has no polling loop.
2. Obey `ctx.signal`. A user abort cancels the wait, not the task. Obey the
   optional wait timeout.
3. Return the exit code, the duration, and the output tail.
4. When the wait ends (resolve, abort, or timeout), decrease
   `task.activeWaiters`. Then check: if the task status is `exited`, the
   `delivered` flag is false, and no other waiter is active, send the alert.
   This step prevents a lost completion after a waiter abort.

Because a waiter is active, the exit handler does not send the automatic
alert for this task. The `delivered` flag covers the race: if the alert was
already sent, `bg_wait` returns the result with a note that says
"also delivered as alert".

### 4.3 `bg_status`: get the task state (R3)

```ts
const BgStatusParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Specific task; omit = all tasks" })),
});
```

The tool returns one line for each task. The line contains the id, the name
or command, the status, the runtime or the exit code, a preview of the output
tail, and the `truncated` flag. The result declares an `outputSchema` and
returns `structuredContent`. This lets codemode scripts use the data.

### 4.4 `bg_output`: read the captured output (R3)

```ts
const BgOutputParams = Type.Object({
  id: Type.String(),
  stream: Type.Optional(Type.String({ enum: ["stdout", "stderr", "combined"] })),
  maxBytes: Type.Optional(Type.Number({ description: "Cap of returned tail bytes (default 8 KiB)" })),
});
```

The tool returns the buffered tail. If the output was truncated, the result
says so. If a `logFile` exists, the result refers the model to that file for
the full log.

### 4.5 `bg_stop`: stop a task

```ts
const BgStopParams = Type.Object({
  id: Type.String(),
  signal: Type.Optional(Type.String({ description: "Signal name (default: TERM)" })),
});
```

If the task status is `exited`, return at once. Do not send a signal. A
signal to a dead process group throws an ESRCH error.

Send SIGTERM to the process group with `process.kill(-pid, sig)`. If the
group does not end in 2 seconds, send SIGKILL to the group. A kill of only
the bash process can leave child processes running. Record the exit like a
normal completion. If no waiter is active, the alert fires. The alert reports
the signal.

### Optional in v1.1: `/bg` command

A `/bg` slash command can show a task table to the human user. The tools
serve the model only. This command is not necessary for R1 to R5.

---

## 5. Completion alerts (R4)

The main logic is in `alerts.ts` and in the process exit handler:

```
process 'exit' event
  |- finalize task (exitCode, exitedAt, clear timeout timer)
  |- statusline.refresh()
  |- if task.activeWaiters > 0 -> do nothing (bg_wait delivers the result)
     else if !task.delivered -> deliver(task)
```

The `deliver` function does three actions:

1. Send a custom message to the model:

```ts
pi.sendMessage(
  {
    customType: "bg-task-complete",
    content: formatResultForModel(task),   // id, command, exit code, duration, output tail (max 4 KiB)
    display: true,
    details: { id, exitCode, durationMs, truncated, logFile },
  },
  { triggerTurn: true, deliverAs: isIdle ? "followUp" : "nextTurn" }
);
```

   `triggerTurn: true` makes Pi start a new turn. Thus the agent reacts
   without a user prompt. If the agent is in a turn, `deliverAs: "nextTurn"`
   queues the message. A background alert shall not interrupt active work.
   `formatResultForModel` always includes the exit code and the last lines
   of output. The function notes that `bg_output` gives the full output.

2. Register a TUI renderer with
   `pi.registerMessageRenderer("bg-task-complete", ...)`. The renderer shows
   a short themed line in the transcript. Exit code 0 shows a green check.
   Other exit codes show a red cross. The id and the command show in dim
   text. This keeps the transcript readable for the human user.

3. If the captured context has a TUI, call `ctx.ui.notify` to tell the user
   that the task finished. Example: "bg task finished: npm test (exit 0)".
   The `ctx` here is the captured copy from the context rules in section 2.

The extension sets the `delivered` flag when it sends the message. A
`bg_wait` call that joins late gets the result and a note that says "also
delivered as alert". The extension sends only one alert for each task.

Keep the content sent to the model at 4 KiB or less. The full log stays in
the TailBuffer or the `logFile`. This obeys the Pi guideline: truncate large
results before you send them to the model.

---

## 6. Process management

- Spawn the process with
  `child_process.spawn("/bin/bash", ["-lc", command], { cwd, env: process.env, detached: true })`.
  The option `detached: true` starts a new process group. Send signals to the
  group with `process.kill(-pid, signal)`. A group kill stops the full
  process tree. The stdin is `ignore`. A command that reads stdin gets EOF at
  once. The v1 target platforms are macOS and Linux. The process group
  functions are not reliable on Windows. Note the platform limit in the
  README.
- When `timeoutMs` expires, mark the task as `timedOut`. Send SIGTERM to the
  process group. If the group does not end in 2 seconds, send SIGKILL to the
  group. Clear the timer at a natural exit.
- Pi calls `session_shutdown` for these reasons: quit, reload, new, resume,
  and fork. The handler is idempotent. It sends SIGTERM to all task groups.
  After 2 seconds, it sends SIGKILL. It clears all timers and detaches all
  stream listeners.
- The config value `killOnShutdown` is `true` by default. If it is `false`,
  the tasks keep running. Their alerts are lost: after reload, new, resume,
  or fork, the new session has a new registry. After a quit, no Pi process
  exists to send an alert. For this reason, the v1 default is kill. Crash
  survival is out of scope (section 9).
- The design has no polling loop. All logic responds to events: `exit`,
  `data`, and wait promises. Only the per-task timeouts use timers.

---

## 7. Status line (R5)

`ctx.ui.setStatus(key, text)` sets the status text. Call
`ctx.ui.setStatus(key, undefined)` to clear the text. The clear gives the
conditional display: the line exists only while tasks exist.

The `statusline.ts` code recomputes the line after each change of the
registry (start, exit, shutdown):

```
refresh():
  const { running, done, failed } = registry.counts();
  if (running + done + failed === 0) setStatus("bg-tasks", undefined);
  else setStatus("bg-tasks", format(running, done, failed));
```

Classification:

- A task with exit code 0 is `done`.
- A task with a nonzero exit code, a kill signal, or a timeout is `failed`.
- The classification uses only the exit fields: `exitCode`, `signal`,
  `timedOut`. `TaskStatus` stays `"running"` or `"exited"`. Thus no schema
  change is necessary.
- Omit each segment when its count is zero.

Format (themed, in line with the Pi footer rules):

| State | Footer text |
|---|---|
| 1 running | `🧵 bg: 1 running` |
| 2 running | `🧵 bg: 2 running` |
| 2 running, 1 done, 1 failed | `🧵 bg: 2 running · 1 done · 1 failed` |
| only done, for example 2 | `🧵 bg: 2 done` |
| only failed, for example 1 | `🧵 bg: 1 failed` |
| zero tasks | the status is cleared entirely |

- The prefix is the emoji 🧵. The emoji does not change with the theme. The
  counts carry the colors.
- Use `ctx.ui.theme.fg(ThemeColor, text)` for each segment. `ThemeColor`
  includes `accent`, `success`, `error`, `dim`, and `muted`. This is the
  same pattern as the Pi status-line example:

```ts
const t = ctx.ui.theme;
const parts: string[] = [];
if (running > 0) parts.push(t.fg("accent",  `${running} running`));
if (done > 0)   parts.push(t.fg("success", `${done} done`));
if (failed > 0) parts.push(t.fg("error",   `${failed} failed`));
// No double space and no dangling separator: join first, prefix last.
ctx.ui.setStatus("bg-tasks", parts.length ? `🧵 bg: ${parts.join(" · ")}` : undefined);
```

- The `failed` count shows in error red. A red count makes failures easy to
  see. The agent and the user notice a failure before they read the alert.
- The `classifyExit` function is a pure helper.
  `classifyExit(task)` returns `"done"` or `"failed"`. Thus the unit tests
  cover all count combinations and all classification rules without real
  processes.
- Exited tasks keep the line visible. The line disappears only when the
  registry is empty. Exited tasks stay in the list until the session ends.
  In v1.1, `bg_status` can get a `clearFinished` action if the footer becomes
  noisy. The v1 default is: keep.
- Mode safety: when the session has no TUI, do not call `setStatus` or
  `notify`. The tools stay fully functional in JSON, RPC, and print modes.

---

## 8. Tool result schema and transcript

- Each tool returns `content` and `details`. The `content` field is an array
  of text parts: `[{ type: "text", text: string }]`. It is not a plain
  string. The `details` field contains a snapshot of the registry: ids,
  statuses, and counts. Renderers and a future state reconstruction can use
  this snapshot.
- `bg_status` and `bg_wait` declare an `outputSchema` and return
  `structuredContent`. The `content` field stays as the text for the model
  and the human user. Apply the same tail cap to the `structuredContent`
  fields.
- No reconstruction happens at `session_start`. Version 1 keeps all state
  in memory. When a session resumes, the registry starts empty. The
  transcript still shows past alerts because custom messages persist in the
  session file.

---

## 9. Scope

In version 1:

- All items in sections 2 to 8: five tools, the alert pipeline, the status
  line, the logFile tee, timeouts, the kill sequence, and the idempotent
  shutdown.
- The platforms macOS and Linux with `bash -lc`.

Out of version 1. Known limits:

- No crash survival. The tasks are killed at shutdown. There is no detached
  runner, no on-disk `status.json`, and no reattach flow. The pi-subagents
  package uses this pattern. It is a candidate for phase 2. The design keeps
  `proc` optional, so a future version can add a stub for a task that
  continues outside Pi.
- No progress messages during a run. The model pulls the state with
  `bg_status` and `bg_output` when it wants it. Alerts fire only at exit.
- No task priorities, queues, or concurrency caps.

Decisions with a default value. All values can change later through a
settings block:

| Decision | v1 default | Reason |
|---|---|---|
| Shell | `bash -lc` | agrees with the environment of the user |
| Tail buffer size | 64 KiB per stream | covers the tails of build and test output |
| Alert size to the model | 4 KiB | obeys the truncation guideline |
| Shutdown behavior | kill all tasks | alerts of orphan processes would be lost |
| Alert delivery during a turn | `deliverAs: "nextTurn"` | do not interrupt active work |
| Exited tasks keep the footer | yes | literal reading of R5 |

---

## 10. Test plan

Use vitest 2.x on Node 26. This is the same stack as pi-children. Run the
tests with `npm test`.

Unit tests:

- Test TailBuffer for the cap, the `truncated` flag, and `totalBytes`.
- Test the statusline formatting for all count combinations. Include the
  zero case that clears the line.
- Test the alert dedupe logic. Test the waiter accounting: `activeWaiters`
  suppress the automatic alert.
- Test the format functions.

Integration tests with real processes:

- Let `sleep 0.1 && echo done` exit. Check the registry transition and the
  exit code.
- Check that `bg_wait` resolves.
- Check that the timeout kills a `sleep 30`.
- Check the `bg_stop` escalation.
- Let `yes | head -c 1M` write much output. Check that the ring buffer
  keeps its cap.

Factory smoke test:

- Load the extension with a mock `ExtensionAPI`.
- Assert the tool registrations and the renderer registration.
- Assert that the factory starts no process.

Alert end-to-end tests with a fake `pi` that captures `sendMessage`:

- Exit with no waiter: one `bg-task-complete` message with
  `triggerTurn: true`.
- Exit while `bg_wait` blocks: no message.
- Late `bg_wait` after delivery: the result and the "also delivered" note.
- Waiter abort after the task exit, before the delivery: the release path of
  `bg_wait` step 4 sends the alert anyway.

Definition of done:

- All tests are green.
- `tsc --noEmit` gives no error.
- The extension was used in a real session: run a slow `npm test` in the
  background, continue the chat, receive the alert, and inspect the output
  with `bg_output`.
