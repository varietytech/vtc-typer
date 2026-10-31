# Variety Tech Typer

A VS Code extension for recording coding tutorials. It types code into the editor like a person
(natural rhythm, pauses before new blocks, the odd corrected typo), runs real commands in the terminal,
and reports everything to a `live/` folder so the work can be reviewed while it happens.

It types through the VS Code editor API, not fake keystrokes, so a popup or a new tab can't steal the
typing, and VS Code's auto-closing brackets and formatting never interfere.

## Use
1. Put `.take` files in `<channel folder>/takes/`.
2. Click **▶ Play take** in the status bar and pick a take. **Pause/Resume** and **Stop** appear while it runs.

## Take files
One command per line, `#` for comments.

| Command | What it does |
|---|---|
| `src <folder>` | where reference code is read from |
| `workspace <folder>` | switch the project folder (relative to the current one) |
| `openfolder` | open the workspace folder in VS Code (the take carries on after the reload) |
| `open <path>` | create/open a file in the workspace |
| `type <src-file> [a-b]` | type lines a–b of a reference file |
| `paste <src-file> [a-b]` | paste a block |
| `text <literal>` | type literal text (`\n` for new line) |
| `goto <line>` / `goto end` | move the cursor |
| `clear` | delete everything in the open file |
| `save` | save, then log TypeScript errors/warnings for the file |
| `check <src-file> [a-b]` | log whether the file matches the reference exactly |
| `terminal <cmd>` | type a command into the terminal and run it |
| `run <cmd>` | run a command without the typing effect |
| `waitdone [s]` | wait until the last terminal command finishes (logs the exit code) |
| `waitout "<text>"` | wait until the terminal prints some text |
| `waitfor <path> [s]` | wait until a file or folder exists |
| `wait <seconds>` | pause |
| `pause [message]` | wait until you click Resume |
| `note <text>` | show a reminder in the status bar and the log |

## Live folder (for review)
- `live/status.json` — current take, step and action
- `live/log.txt` — every step, terminal commands and exit codes, saves with their problems, checks
- `live/snapshot.json` — open files, all current problems, recent terminal output (written at the end
  of each take, or with the command *VTC: Report snapshot now*)
- Read-only requests: write `live/request.json` as `{"id": "1", "action": "snapshot"}` or
  `{"id": "2", "action": "read", "file": "app/index.tsx"}`; the answer appears in `live/response-<id>.json`.

## Settings
`vtc.channelFolder`, `vtc.srcRoot`, `vtc.speed` (1.0 = about 6–7 characters a second), `vtc.typos`.

## Tests
    node test/run-tests.js
    node test/prompt-test.js

Runs the extension against a small fake of the VS Code API: typing, paste and clear reproduce a reference
file exactly, terminal commands are typed and run, read-only requests are answered, and a take resumes
after `openfolder` reloads the window.
