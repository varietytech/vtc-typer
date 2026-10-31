// Variety Tech Typer — VS Code extension.
// Types "takes" into the editor through the VS Code API (no fake keystrokes, so popups can't steal them),
// runs terminal commands with shell integration, and reports everything to <channel>/live/ for Claude.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

let ctx;
let state = { running: false, paused: false, stop: false, take: null, step: 0, total: 0, label: "" };
let sbPlay, sbPause, sbStop, sbInfo;
const termOut = [];                 // last terminal output lines (ring buffer)
const execs = [];                   // recent executions: {cmd, exit, done}
let ws = null;                      // current workspace root (absolute)
let srcRoot = null;
let expected = {};                  // file -> text we intended (for checks)

// ------------------------------------------------------------------ config + paths
const cfg = () => vscode.workspace.getConfiguration("vtc");
const channel = () => cfg().get("channelFolder");
const liveDir = () => path.join(channel(), "live");
const takesDir = () => path.join(channel(), "takes");

function ensureDirs() {
  for (const d of [liveDir(), takesDir()]) fs.mkdirSync(d, { recursive: true });
}

// ------------------------------------------------------------------ reporting to Claude
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  try { fs.appendFileSync(path.join(liveDir(), "log.txt"), line + "\n"); } catch (e) {}
}

function writeStatus(extra = {}) {
  const s = {
    time: new Date().toISOString(),
    running: state.running, paused: state.paused, take: state.take, step: state.step, total: state.total,
    doing: state.label, workspace: ws, activeFile: vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.uri.fsPath : null, ...extra,
  };
  try { fs.writeFileSync(path.join(liveDir(), "status.json"), JSON.stringify(s, null, 2)); } catch (e) {}
  updateBar();
}

function diagnosticsFor(uri) {
  return vscode.languages.getDiagnostics(uri).map((d) => ({
    severity: ["error", "warning", "info", "hint"][d.severity],
    line: d.range.start.line + 1, col: d.range.start.character + 1, message: d.message,
    source: d.source || "", code: typeof d.code === "object" ? String(d.code.value) : String(d.code ?? ""),
  }));
}

function snapshot(reason = "manual") {
  const all = vscode.languages.getDiagnostics()
    .filter(([uri, ds]) => ds.length && !uri.fsPath.includes("node_modules"))
    .map(([uri, ds]) => ({ file: uri.fsPath, problems: diagnosticsFor(uri) }));
  const editors = vscode.window.visibleTextEditors.map((e) => ({
    file: e.document.uri.fsPath, dirty: e.document.isDirty, lines: e.document.lineCount,
    cursor: e.selection.active.line + 1,
  }));
  const snap = {
    time: new Date().toISOString(), reason, workspace: ws,
    activeFile: vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : null,
    editors, problems: all, terminals: vscode.window.terminals.map((t) => t.name),
    recentCommands: execs.slice(-15), terminalOutput: termOut.slice(-150),
  };
  fs.writeFileSync(path.join(liveDir(), "snapshot.json"), JSON.stringify(snap, null, 2));
  return snap;
}

// Read-only requests from Claude: drop live/request.json = {id, action: "snapshot"|"read"|"problems", file?}
function pollRequests() {
  const p = path.join(liveDir(), "request.json");
  if (!fs.existsSync(p)) return;
  let req;
  try { req = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return; }
  try { fs.unlinkSync(p); } catch (e) {}
  const out = path.join(liveDir(), `response-${req.id || "x"}.json`);
  try {
    let res;
    if (req.action === "read") {
      const f = path.isAbsolute(req.file) ? req.file : path.join(ws || "", req.file);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === f.toLowerCase());
      res = { file: f, fromEditor: !!open, text: open ? open.getText() : fs.readFileSync(f, "utf8"),
              problems: diagnosticsFor(vscode.Uri.file(f)) };
    } else {
      res = snapshot("request");
    }
    fs.writeFileSync(out, JSON.stringify({ id: req.id, ok: true, ...res }, null, 2));
  } catch (e) {
    fs.writeFileSync(out, JSON.stringify({ id: req.id, ok: false, error: String(e) }, null, 2));
  }
  log(`answered request ${req.id} (${req.action})`);
}

// ------------------------------------------------------------------ status bar
function updateBar() {
  if (!sbPlay) return;
  sbPlay.text = state.running ? "$(loading~spin) VTC" : "$(play) Play take";
  sbPause.text = state.paused ? "$(debug-continue) Resume" : "$(debug-pause) Pause";
  sbPause.backgroundColor = state.paused ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  state.running ? (sbPause.show(), sbStop.show()) : (sbPause.hide(), sbStop.hide());
  sbInfo.text = state.running ? `${state.step}/${state.total} ${state.label}`.slice(0, 70) : "";
  state.running ? sbInfo.show() : sbInfo.hide();
}

// ------------------------------------------------------------------ timing
const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
class Stopped extends Error {}
async function sleep(sec) {
  let left = sec * 1000;
  while (left > 0) {
    if (state.stop) throw new Stopped();
    while (state.paused) { await sleepRaw(100); if (state.stop) throw new Stopped(); }
    const t = Math.min(50, left);
    await sleepRaw(t);
    left -= t;
  }
}
function rnd(a, b) { return a + Math.random() * (b - a); }
function lognorm(mu, sigma) {
  const u = 1 - Math.random(), v = Math.random();
  return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}
function keyDelay(c, prev) {
  let d = lognorm(Math.log(0.13), 0.38);
  if ("(){}[]<>=:;'\"`.,/\\|&!?".includes(c) || "(){}[].".includes(prev)) d *= 1.6;
  if (c === " ") d *= 1.2;
  if (c !== c.toLowerCase()) d *= 1.35;
  if (prev === " " && /[a-z]/i.test(c) && Math.random() < 0.08) d += rnd(0.25, 0.7);
  return Math.min(d, 0.9) / cfg().get("speed");
}

// ------------------------------------------------------------------ editor actions
async function editorFor(file) {
  // wait until the document is visible in an editor (if the user switched tabs we pause, not break)
  for (;;) {
    const e = vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath.toLowerCase() === file.toLowerCase());
    if (e) return e;
    if (state.stop) throw new Stopped();
    state.label = `waiting for ${path.basename(file)} to be visible`;
    writeStatus();
    await sleepRaw(300);
  }
}

async function insertAt(file, text) {
  const e = await editorFor(file);
  const pos = e.selection.active;
  const ok = await e.edit((b) => b.insert(pos, text), { undoStopBefore: false, undoStopAfter: false });
  if (!ok) throw new Error("edit failed");
  const lines = text.split("\n");
  const end = lines.length === 1 ? pos.translate(0, text.length) : new vscode.Position(pos.line + lines.length - 1, lines[lines.length - 1].length);
  e.selection = new vscode.Selection(end, end);
  e.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function backspace(file) {
  const e = await editorFor(file);
  const pos = e.selection.active;
  if (pos.character === 0) return;
  const start = pos.translate(0, -1);
  await e.edit((b) => b.delete(new vscode.Range(start, pos)), { undoStopBefore: false, undoStopAfter: false });
  e.selection = new vscode.Selection(start, start);
}

let current = null; // active file (absolute)

async function cmdOpen(rel) {
  const f = path.join(ws, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, "");
  const doc = await vscode.workspace.openTextDocument(f);
  const e = await vscode.window.showTextDocument(doc, { preview: false });
  const last = doc.lineAt(doc.lineCount - 1);
  e.selection = new vscode.Selection(last.range.end, last.range.end);
  current = f;
  log(`open ${rel}`);
  await sleep(1.0);
}

async function cmdGoto(arg) {
  const e = await editorFor(current);
  const doc = e.document;
  const line = arg === "end" ? doc.lineCount - 1 : Math.min(parseInt(arg, 10) - 1, doc.lineCount - 1);
  const p = doc.lineAt(line).range.end;
  e.selection = new vscode.Selection(p, p);
  e.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await sleep(0.4);
}

function readSource(spec) {
  const m = spec.trim().match(/^(.+?)(?:\s+(\d+)-(\d+))?$/);
  const f = path.isAbsolute(m[1]) ? m[1] : path.join(srcRoot, m[1]);
  let lines = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (m[2]) lines = lines.slice(parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return lines;
}

async function cmdType(lines) {
  const e = await editorFor(current);
  const curLine = e.document.lineAt(e.selection.active.line).text;
  const startEmpty = curLine.length === 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    state.label = `typing line ${e.selection.active.line + 1}`;
    writeStatus();
    if (i > 0 || !startEmpty) {
      await insertAt(current, "\n");
      let gap = rnd(0.25, 0.6);
      if (i > 0 && lines[i - 1].trim() === "") gap += rnd(0.6, 1.5);
      await sleep(gap / cfg().get("speed"));
    }
    const body = line.replace(/^ +/, "");
    let ind = line.length - body.length;
    while (ind > 0) {                                   // indentation in Tab-sized steps
      const n = Math.min(2, ind);
      await insertAt(current, " ".repeat(n));
      ind -= n;
      await sleep(rnd(0.06, 0.12));
    }
    let prev = "";
    for (const c of body) {
      if (/[a-z]/i.test(c) && /[a-z]/i.test(prev) && Math.random() < cfg().get("typos")) {
        await insertAt(current, "qwertyuiopasdfghjklzxcvbnm"[Math.floor(Math.random() * 26)]);
        await sleep(rnd(0.2, 0.45));
        await backspace(current);
        await sleep(rnd(0.1, 0.2));
      }
      await sleep(keyDelay(c, prev));
      await insertAt(current, c);
      prev = c;
    }
  }
  await sleep(rnd(0.5, 1.0));
}

async function cmdPaste(lines) {
  const e = await editorFor(current);
  const curLine = e.document.lineAt(e.selection.active.line).text;
  await sleep(0.3);
  await insertAt(current, (curLine.length ? "\n" : "") + lines.join("\n"));
  log(`paste ${lines.length} lines`);
  await sleep(1.0);
}

async function cmdClear() {
  const e = await editorFor(current);
  e.selection = new vscode.Selection(0, 0, e.document.lineCount, 0);
  await sleep(0.5);
  await e.edit((b) => b.delete(new vscode.Range(0, 0, e.document.lineCount, 0)));
  e.selection = new vscode.Selection(0, 0, 0, 0);
  log(`clear ${path.basename(current)}`);
  await sleep(0.6);
}

async function cmdSave() {
  const e = await editorFor(current);
  await e.document.save();
  state.label = "saved";
  await sleep(2.0);                                    // let TypeScript catch up
  const probs = diagnosticsFor(e.document.uri);
  const errs = probs.filter((p) => p.severity === "error");
  log(`save ${path.relative(ws, current)} — ${errs.length} errors, ${probs.length - errs.length} other`);
  for (const p of probs) log(`   ${p.severity} L${p.line}: ${p.message}`);
  writeStatus({ lastSave: { file: current, problems: probs } });
}

async function cmdCheck(spec) {
  const e = await editorFor(current);
  const want = readSource(spec).join("\n");
  const got = e.document.getText().replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const ok = got === want;
  log(ok ? `check ✅ ${path.basename(current)} matches ${spec}` : `check ⚠️ ${path.basename(current)} differs from ${spec}`);
  writeStatus({ lastCheck: { file: current, spec, match: ok } });
}

// ------------------------------------------------------------------ terminal
let term = null;
function getTerm() {
  if (term && vscode.window.terminals.includes(term)) return term;
  term = vscode.window.createTerminal({ name: "VTC", cwd: ws });
  return term;
}

async function waitShellIntegration(t, ms = 8000) {
  const t0 = Date.now();
  while (!t.shellIntegration && Date.now() - t0 < ms) await sleepRaw(200);
  return !!t.shellIntegration;
}

async function cmdTerminal(cmd, typeIt = true) {
  const t = getTerm();
  t.show(false);
  await waitShellIntegration(t);
  await sleep(0.6);
  log(`terminal> ${cmd}`);
  state.execMark = execs.length;
  if (typeIt) {
    let prev = "";
    for (const c of cmd) { await sleep(keyDelay(c, prev)); t.sendText(c, false); prev = c; }
    await sleep(0.4);
  } else {
    t.sendText(cmd, false);
  }
  t.sendText("", true);                                 // Enter
  await sleep(0.8);
}

async function cmdWaitDone(timeout = 900) {
  // wait for the last terminal command to finish (shell integration), logs its exit code
  const t0 = Date.now();
  state.label = "waiting for the command to finish";
  writeStatus();
  while (Date.now() - t0 < timeout * 1000) {
    const mine = execs.slice(state.execMark || 0);
    const last = mine[mine.length - 1];
    if (last && last.done) { log(`command finished: exit ${last.exit}`); return; }
    await sleep(0.5);
  }
  log("gave up waiting for the command");
}

async function cmdWaitOut(text, timeout = 300) {
  const t0 = Date.now();
  state.label = `waiting for "${text}"`;
  writeStatus();
  const mark = termOut.length;
  while (Date.now() - t0 < timeout * 1000) {
    if (termOut.slice(Math.max(0, mark - 5)).some((l) => l.includes(text))) { log(`saw "${text}"`); return; }
    await sleep(0.5);
  }
  log(`did not see "${text}"`);
}

async function cmdWaitFor(arg) {
  const [rel, to] = arg.split(/\s+/);
  const f = path.join(ws, rel);
  const t0 = Date.now(), timeout = (parseFloat(to) || 900) * 1000;
  state.label = `waiting for ${rel}`;
  writeStatus();
  while (!fs.existsSync(f) && Date.now() - t0 < timeout) await sleep(0.5);
}

// ------------------------------------------------------------------ take runner
function parseTake(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf(" "); return i < 0 ? [l.toLowerCase(), ""] : [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; });
}

async function runTake(file, startAt = 0) {
  ensureDirs();
  const cmds = parseTake(file);
  Object.assign(state, { running: true, paused: false, stop: false, take: path.basename(file), step: startAt, total: cmds.length });
  ws = ws || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : null);
  srcRoot = srcRoot || cfg().get("srcRoot");
  log(`▶ take ${path.basename(file)} from step ${startAt + 1} (workspace ${ws})`);
  writeStatus();
  let reloading = false;
  try {
    for (let i = startAt; i < cmds.length; i++) {
      const [op, arg] = cmds[i];
      state.step = i + 1;
      state.label = `${op} ${arg}`.slice(0, 80);
      writeStatus();
      switch (op) {
        case "workspace": ws = path.resolve(ws, arg); log(`workspace ${ws}`); break;
        case "src": srcRoot = path.isAbsolute(arg) ? arg : path.join(channel(), arg); break;
        case "open": await cmdOpen(arg); break;
        case "goto": await cmdGoto(arg); break;
        case "type": await cmdType(readSource(arg)); break;
        case "paste": await cmdPaste(readSource(arg)); break;
        case "text": await cmdType(arg.replace(/\\n/g, "\n").split("\n")); break;
        case "clear": await cmdClear(); break;
        case "save": await cmdSave(); break;
        case "check": await cmdCheck(arg); break;
        case "terminal": await cmdTerminal(arg, true); break;
        case "run": await cmdTerminal(arg, false); break;
        case "waitdone": await cmdWaitDone(parseFloat(arg) || 900); break;
        case "waitout": await cmdWaitOut(arg.replace(/^"|"$/g, "")); break;
        case "waitfor": await cmdWaitFor(arg); break;
        case "wait": await sleep(parseFloat(arg)); break;
        case "note": log(`note: ${arg}`); vscode.window.setStatusBarMessage(`🗒 ${arg}`, 8000); break;
        case "pause":
          state.paused = true; log(`paused: ${arg || "click Resume to continue"}`); writeStatus();
          while (state.paused) { await sleepRaw(150); if (state.stop) throw new Stopped(); }
          break;
        case "editor": await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup"); await sleep(0.4); break;
        case "openfolder": {
          await ctx.globalState.update("vtc.resume", { file, step: i + 1, ws, srcRoot, at: Date.now() });
          reloading = true;
          log(`open folder ${ws} (window reloads, take continues)`);
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(ws), false);
          return;                                         // extension restarts in the new window and resumes
        }
        default: log(`unknown command: ${op}`);
      }
    }
    log(`■ take finished`);
    vscode.window.showInformationMessage(`Take finished: ${path.basename(file)}`);
  } catch (e) {
    if (e instanceof Stopped) log("■ stopped"); else { log(`✖ error: ${e.message}`); vscode.window.showErrorMessage(`VTC: ${e.message}`); }
  } finally {
    if (!reloading) await ctx.globalState.update("vtc.resume", undefined);
    state.running = false;
    snapshot(reloading ? "reloading window" : "take end");
    writeStatus();
  }
}

// ------------------------------------------------------------------ activation
function activate(context) {
  ctx = context;
  ensureDirs();
  sbPlay = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  sbPlay.command = "vtc.play"; sbPlay.tooltip = "Variety Tech Typer: play a take"; sbPlay.show();
  sbPause = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999); sbPause.command = "vtc.pause";
  sbStop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998); sbStop.command = "vtc.stop";
  sbStop.text = "$(debug-stop) Stop";
  sbInfo = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 997);
  updateBar();

  context.subscriptions.push(
    vscode.commands.registerCommand("vtc.play", async () => {
      if (state.running) return;
      ensureDirs();
      const takes = fs.readdirSync(takesDir()).filter((f) => f.endsWith(".take")).sort();
      if (!takes.length) return vscode.window.showWarningMessage(`No .take files in ${takesDir()}`);
      const pick = await vscode.window.showQuickPick(takes, { placeHolder: "Which take?" });
      if (pick) runTake(path.join(takesDir(), pick));
    }),
    vscode.commands.registerCommand("vtc.pause", () => { state.paused = !state.paused; log(state.paused ? "paused" : "resumed"); writeStatus(); }),
    vscode.commands.registerCommand("vtc.stop", () => { state.stop = true; state.paused = false; }),
    vscode.commands.registerCommand("vtc.snapshot", () => { snapshot("button"); vscode.window.setStatusBarMessage("VTC: snapshot written", 3000); }),
    sbPlay, sbPause, sbStop, sbInfo,
  );

  // terminal output capture (shell integration)
  if (vscode.window.onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (ev) => {
        const rec = { cmd: ev.execution.commandLine ? ev.execution.commandLine.value : "", exit: null, done: false, terminal: ev.terminal.name };
        execs.push(rec); if (execs.length > 500) execs.shift();
        try {
          let buf = "";
          for await (const chunk of ev.execution.read()) {
            buf += chunk.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
            const parts = buf.split(/\r?\n/); buf = parts.pop();
            for (const p of parts) { const s = p.replace(/\r/g, "").trimEnd(); if (s) { termOut.push(s); if (termOut.length > 400) termOut.shift(); } }
          }
          if (buf.trim()) termOut.push(buf.trim());
        } catch (e) {}
      }),
      vscode.window.onDidEndTerminalShellExecution((ev) => {
        const cmd = ev.execution.commandLine ? ev.execution.commandLine.value : "";
        const rec = [...execs].reverse().find((r) => !r.done && r.cmd === cmd) || execs[execs.length - 1];
        if (rec) { rec.done = true; rec.exit = ev.exitCode; }
        log(`terminal finished (${ev.exitCode}): ${cmd}`);
      }),
    );
  }

  // read-only requests from Claude
  const timer = setInterval(pollRequests, 1500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // resume a take after "openfolder" reloaded the window
  const resume = context.globalState.get("vtc.resume");
  context.globalState.update("vtc.resume", undefined);
  if (resume && resume.file && fs.existsSync(resume.file) && Date.now() - (resume.at || 0) < 120000) {
    ws = resume.ws; srcRoot = resume.srcRoot;
    log(`resuming ${path.basename(resume.file)} at step ${resume.step + 1}`);
    setTimeout(() => runTake(resume.file, resume.step), 4000);
  }
  log(`extension ready (VS Code ${vscode.version})`);
  writeStatus();
}

function deactivate() {}
module.exports = { activate, deactivate };
