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
let termPartial = "";               // current unfinished line (prompts like "(Y/n): " have no newline)
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
    await typeChars(body);
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

// type a string on the current line, character by character
async function typeChars(text) {
  let prev = "";
  for (const c of text) {
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

function jsonArg(s) { try { return JSON.parse(s); } catch (e) { return s.replace(/^"|"$/g, ""); } }
// split  "a b" "c"  /  12 "x"  into tokens (JSON strings stay whole)
function tokens(arg) { return (arg.match(/"(?:[^"\\]|\\.)*"|\S+/g) || []).map(jsonArg); }

function findLine(doc, anchor, from = 0) {
  for (let i = from; i < doc.lineCount; i++) if (doc.lineAt(i).text.includes(anchor)) return i;
  throw new Error(`no line containing ${JSON.stringify(anchor)} in ${path.basename(doc.uri.fsPath)}`);
}

async function place(e, line, ch) {
  const p = new vscode.Position(line, ch);
  e.selection = new vscode.Selection(p, p);
  e.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await sleep(0.5);
}

// new empty line that becomes line N (old line N moves down); cursor goes there
async function cmdInsert(n) {
  const e = await editorFor(current);
  const doc = e.document;
  if (n - 1 < doc.lineCount) {
    await place(e, n - 1, 0);
    await e.edit((b) => b.insert(new vscode.Position(n - 1, 0), "\n"), { undoStopBefore: false, undoStopAfter: false });
    await place(e, n - 1, 0);
  } else {
    const last = doc.lineAt(doc.lineCount - 1);
    await place(e, last.lineNumber ?? doc.lineCount - 1, last.text.length);
    await insertAt(current, "\n");
  }
}

// select lines a..b so the viewer sees them, then delete them
async function cmdDeleteLines(spec) {
  const [a, b] = spec.split("-").map((x) => parseInt(x, 10));
  const e = await editorFor(current);
  const doc = e.document;
  let r;
  if (b < doc.lineCount) r = new vscode.Range(a - 1, 0, b, 0);
  else if (a > 1) r = new vscode.Range(a - 2, doc.lineAt(a - 2).text.length, b - 1, doc.lineAt(b - 1).text.length);
  else r = new vscode.Range(0, 0, b - 1, doc.lineAt(b - 1).text.length);
  e.selection = new vscode.Selection(r.start, r.end);
  e.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await sleep(0.9);
  await e.edit((x) => x.delete(r), { undoStopBefore: false, undoStopAfter: false });
  e.selection = new vscode.Selection(r.start, r.start);
  log(`deleted lines ${spec}`);
  await sleep(0.5);
}

// replace characters c1..c2 (0-based, end exclusive) of line N with text, typed
async function cmdSplice(n, c1, c2, text) {
  const e = await editorFor(current);
  const line = n - 1;
  if (c2 > c1) {
    const r = new vscode.Range(line, c1, line, c2);
    e.selection = new vscode.Selection(r.start, r.end);
    e.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await sleep(0.8);
    await e.edit((x) => x.delete(r), { undoStopBefore: false, undoStopAfter: false });
  }
  await place(e, line, c1);
  await typeChars(text);
  await sleep(rnd(0.4, 0.8));
}

// cursor to the end of the first line containing anchor
async function cmdAfter(anchor) {
  const e = await editorFor(current);
  const i = findLine(e.document, anchor);
  await place(e, i, e.document.lineAt(i).text.length);
}

// new empty line above the first line containing anchor; cursor goes there
async function cmdAbove(anchor) {
  const e = await editorFor(current);
  await cmdInsert(findLine(e.document, anchor) + 1);
}

// retype the first line containing anchor (keeps its indentation)
async function cmdSetLine(anchor, content) {
  const e = await editorFor(current);
  const i = findLine(e.document, anchor);
  const t = e.document.lineAt(i).text;
  const ind = t.length - t.trimStart().length;
  await cmdSplice(i + 1, ind, t.length, content.trimStart());
}

// write a chapter snapshot into the workspace: files in it are written, files only in other chapters are removed
async function cmdRestore(name) {
  for (const d of vscode.workspace.textDocuments.filter((x) => x.isDirty && !x.isUntitled)) {
    try { await vscode.window.showTextDocument(d, { preview: false }); await vscode.commands.executeCommand("workbench.action.files.revert"); log(`reverted unsaved ${path.basename(d.uri.fsPath)}`); }
    catch (e) { log(`could not revert ${d.uri.fsPath}: ${e.message}`); }
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const root = path.join(srcRoot, name);
  if (!fs.existsSync(root)) throw new Error(`no snapshot folder ${root}`);
  const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) =>
    x.isDirectory() ? walk(path.join(d, x.name), base) : [path.relative(base, path.join(d, x.name))]);
  const all = new Set();
  for (const ch of fs.readdirSync(srcRoot, { withFileTypes: true }).filter((x) => x.isDirectory()))
    walk(path.join(srcRoot, ch.name)).forEach((f) => all.add(f));
  const mine = new Set(walk(root));
  for (const f of all) {
    const dest = path.join(ws, f);
    if (mine.has(f)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, f), dest); }
    else if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }
  // remove folders left empty (e.g. src/app/scan)
  const prune = (d) => { if (!fs.existsSync(d)) return; for (const x of fs.readdirSync(d, { withFileTypes: true })) if (x.isDirectory()) prune(path.join(d, x.name));
    if (d !== ws && !fs.readdirSync(d).length && [...all].some((f) => path.join(ws, f).startsWith(d + path.sep))) fs.rmdirSync(d); };
  prune(path.join(ws, "src"));
  current = null;
  log(`restore ${name}: ${mine.size} files written`);
  await sleep(1.0);
}

// ------------------------------------------------------------------ OBS (obs-websocket v5, built into OBS 28+)
async function obsRequest(requestType) {
  if (typeof WebSocket === "undefined") throw new Error("this VS Code has no WebSocket; start/stop OBS by hand");
  const crypto = require("crypto");
  const sha = (s) => crypto.createHash("sha256").update(s).digest("base64");
  // settings win; otherwise <channel>/tools/obs-websocket.json = {"port": 4455, "password": "..."}
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(channel(), "tools", "obs-websocket.json"), "utf8")); } catch (e) {}
  const port = cfg().get("obsPort") || file.port || 4455, password = cfg().get("obsPassword") || file.password || "";
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    const done = (err, v) => { clearTimeout(timer); try { sock.close(); } catch (e) {} err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => done(new Error(`OBS did not answer on port ${port} (is the WebSocket server on?)`)), 6000);
    sock.onerror = () => done(new Error(`could not reach OBS on port ${port} (Tools → WebSocket Server Settings)`));
    sock.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (m.op === 0) {
        const d = { rpcVersion: 1 };
        if (m.d.authentication) d.authentication = sha(sha(password + m.d.authentication.salt) + m.d.authentication.challenge);
        sock.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) {
        sock.send(JSON.stringify({ op: 6, d: { requestType, requestId: "vtc" } }));
      } else if (m.op === 7) {
        const st = m.d.requestStatus || {};
        st.result ? done(null, m.d.responseData || {}) : done(new Error(`OBS ${requestType}: ${st.comment || st.code}`));
      }
    };
  });
}

async function waitRecording(active, seconds) {
  const t0 = Date.now();
  for (;;) {
    const st = await obsRequest("GetRecordStatus");
    if (!!st.outputActive === active) return true;
    if (Date.now() - t0 > seconds * 1000) return false;
    await sleepRaw(500);
  }
}

async function cmdRecord(what) {
  const type = { start: "StartRecord", stop: "StopRecord", status: "GetRecordStatus" }[what];
  if (!type) throw new Error(`record start|stop|status, not "${what}"`);
  try {
    if (what === "start") {
      // OBS may still be saving the previous file: wait for it instead of skipping the start
      if (!(await waitRecording(false, 60))) throw new Error("OBS was still recording 60 s later; stop it by hand");
      try { await vscode.commands.executeCommand("notifications.clearAll"); } catch (e) {}
      await statusBar(false);
      await sleepRaw(400);
      await obsRequest("StartRecord");
      if (!(await waitRecording(true, 15))) throw new Error("OBS did not start recording");
      log("OBS start");
      writeStatus({ obs: { recording: true } });
      await sleep(1.5);                                // a beat of still frame before typing
      return;
    }
    const r = await obsRequest(type);
    if (what === "stop") {
      const done = await waitRecording(false, 120);    // wait until the file is fully written
      log(`OBS stop${r.outputPath ? ` → ${r.outputPath}` : ""}${done ? "" : " (still saving after 120 s)"}`);
      await statusBar(true);
      writeStatus({ obs: { recording: false, outputPath: r.outputPath } });
      return;
    }
    log(`OBS status: ${JSON.stringify(r)}`);
  } catch (e) {
    if (what === "stop") { log(`⚠️ ${e.message}`); await statusBar(true); return; }  // never lose the take over a stop
    throw e;
  }
}

// ------------------------------------------------------------------ take runner
function parseTake(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf(" "); return i < 0 ? [l.toLowerCase(), ""] : [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; });
}

// VS Code features that react to document edits (not just keystrokes) and would change typed code
const SAFE = { "typescript.autoClosingTags": false, "javascript.autoClosingTags": false, "html.autoClosingTags": false,
  "editor.linkedEditing": false, "files.eol": "\n", "editor.formatOnType": false, "editor.formatOnPaste": false };
async function applySafeSettings() {
  for (const [k, v] of Object.entries(SAFE)) {
    try { if (vscode.workspace.getConfiguration().get(k) !== v) await vscode.workspace.getConfiguration().update(k, v, vscode.ConfigurationTarget.Workspace); }
    catch (e) { log(`could not set ${k}: ${e.message}`); }
  }
}
async function statusBar(visible) {
  try { await vscode.workspace.getConfiguration().update("workbench.statusBar.visible", visible, vscode.ConfigurationTarget.Workspace); }
  catch (e) { log(`status bar: ${e.message}`); }
}

async function runTake(file, startAt = 0) {
  let cmds;
  try { ensureDirs(); cmds = parseTake(file); }
  catch (e) { log(`✖ could not read take ${file}: ${e.message}`); return; }
  Object.assign(state, { running: true, paused: false, stop: false, take: path.basename(file), step: startAt, total: cmds.length });
  ws = ws || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : null);
  srcRoot = srcRoot || cfg().get("srcRoot");
  log(`▶ take ${path.basename(file)} from step ${startAt + 1} (workspace ${ws})`);
  if (ws) await applySafeSettings();
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
        case "text": { const v = arg.startsWith('"') ? String(jsonArg(arg)) : arg.replace(/\\n/g, "\n"); await cmdType(v.split("\n")); break; }
        case "clear": await cmdClear(); break;
        case "save": await cmdSave(); break;
        case "check": await cmdCheck(arg); break;
        case "terminal": await cmdTerminal(arg, true); break;
        case "run": await cmdTerminal(arg, false); break;
        case "waitdone": await cmdWaitDone(arg); break;
        case "waitout": { const t = tokens(arg); await cmdWaitOut(String(t[0]), parseFloat(t[1]) || 300); break; }
        case "insert": await cmdInsert(parseInt(arg, 10)); break;
        case "deletelines": await cmdDeleteLines(arg); break;
        case "splice": { const t = tokens(arg); await cmdSplice(+t[0], +t[1], +t[2], String(t[3] ?? "")); break; }
        case "after": await cmdAfter(String(tokens(arg)[0])); break;
        case "above": await cmdAbove(String(tokens(arg)[0])); break;
        case "setline": { const t = tokens(arg); await cmdSetLine(String(t[0]), String(t[1])); break; }
        case "newline": await insertAt(current, "\n"); break;
        case "restore": await cmdRestore(arg); break;
        case "closeall": await vscode.commands.executeCommand("workbench.action.closeAllEditors"); current = null; await sleep(0.6); break;
        case "record": await cmdRecord(arg.trim()); break;
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
          writeLook(ws);
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
    if (cmds && cmds.some(([o, a]) => o === "record" && a.trim() === "start")) await cmdRecord("stop").catch(() => {});
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
      if (pick) runTake(path.join(takesDir(), pick)).catch((e) => log(`✖ take failed: ${e && e.stack || e}`));
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
            buf += chunk.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
              .replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/[\u2800-\u28ff]+/g, "");
            const parts = buf.split(/\r?\n/); buf = parts.pop(); termPartial = buf;
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

  // self-update: a newer vtc-typer-X.Y.Z.vsix in <channel>/tools/vtc-extension installs itself
  setTimeout(async () => {
    try {
      const dir = path.join(channel(), "tools", "vtc-extension");
      const mine = context.extension ? context.extension.packageJSON.version : "0.0.0";
      const ver = (v) => v.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0);
      const best = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => [f, (f.match(/^vtc-typer-(\d+\.\d+\.\d+)\.vsix$/) || [])[1]])
        .filter(([, v]) => v && ver(v) > ver(mine)).sort((a, b) => ver(b[1]) - ver(a[1]))[0];
      if (!best || state.running) return;
      log(`updating vtc-typer ${mine} -> ${best[1]}`);
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(path.join(dir, best[0])));
      log(`installed ${best[1]}: reloading the window`);
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } catch (e) { log(`self-update failed: ${e.message}`); }
  }, 6000);

  // read-only requests from Claude
  const timer = setInterval(pollRequests, 1500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // resume a take after "openfolder" reloaded the window
  const resume = context.globalState.get("vtc.resume");
  context.globalState.update("vtc.resume", undefined);
  if (resume && resume.file && fs.existsSync(resume.file) && Date.now() - (resume.at || 0) < 120000) {
    ws = resume.ws; srcRoot = resume.srcRoot;
    log(`resuming ${path.basename(resume.file)} at step ${resume.step + 1}`);
    setTimeout(() => {
      log("resume: starting now");
      runTake(resume.file, resume.step).catch((e) => log(`✖ resume failed: ${e && e.stack || e}`));
    }, 4000);
  }
  log(`extension ready (VS Code ${vscode.version})`);
  writeStatus();
}

process.on && process.on("unhandledRejection", (e) => { try { log(`✖ unhandled: ${e && e.stack || e}`); } catch (x) {} });
function deactivate() { try { log("extension stopped (window closing or reloading)"); } catch (e) {} }
module.exports = { activate, deactivate };
