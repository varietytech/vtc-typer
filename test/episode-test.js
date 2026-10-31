// Plays every chapter take of an episode in order against the fake VS Code + fake OBS,
// and checks that each chapter ends with files identical to its snapshot.
//   node test/episode-test.js <episode folder with chapters/ and takes/> <src path used in takes>
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const [EP, SRCREL] = process.argv.slice(2);
const T = path.join(os.tmpdir(), "vtc-episode"); process.env.VTC_TEST_DIR = T;
process.env.VTC_SPEED = "3000"; process.env.VTC_OBS_PORT = "48455"; process.env.VTC_OBS_PASSWORD = "pw-test";
fs.rmSync(T, { recursive: true, force: true });
const SRC = path.join(T, "channel", SRCREL), WS = path.join(T, "ws");
fs.cpSync(path.join(EP, "chapters"), SRC, { recursive: true });
fs.cpSync(path.join(EP, "takes"), path.join(T, "channel/takes"), { recursive: true });
fs.cpSync(path.join(SRC, "ch2"), WS, { recursive: true });           // what reset-project left behind
fs.writeFileSync(path.join(WS, "package.json"), "{}");               // a file no chapter touches must survive
process.env.NODE_PATH = path.join(__dirname, "fake"); Module._initPaths();
const vscode = require("vscode");
const ext = require("../extension.js");
const cmds = {}; vscode.commands.registerCommand = (n, f) => { cmds[n] = f; return { dispose() {} }; };
const store = new Map();
const ctx = { subscriptions: [], globalState: { get: (k) => store.get(k), update: async (k, v) => store.set(k, v) } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const walk = (d, b = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(path.join(d, x.name), b) : [path.relative(b, path.join(d, x.name))]);
let failed = 0; const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) failed++; };
(async () => {
  const obs = await require("./fake-obs")(48455, "pw-test");
  ext.activate(ctx);
  const takes = fs.readdirSync(path.join(T, "channel/takes")).filter((f) => /-ch\d+-/.test(f) && /^restore /m.test(fs.readFileSync(path.join(T, "channel/takes", f), "utf8"))).sort((a, b) => +a.match(/ch(\d+)/)[1] - +b.match(/ch(\d+)/)[1]);
  const logf = path.join(T, "channel/live/log.txt");
  for (const take of takes) {
    const ch = take.match(/ch(\d+)/)[1];
    const before = fs.existsSync(logf) ? fs.readFileSync(logf, "utf8").length : 0;
    vscode.window.showQuickPick = async () => take;
    const t0 = Date.now();
    await cmds["vtc.play"]();
    await wait(300);
    while (JSON.parse(fs.readFileSync(path.join(T, "channel/live/status.json"), "utf8")).running) await wait(100);
    const log = fs.readFileSync(logf, "utf8").slice(before);
    const want = path.join(SRC, `ch${ch}`);
    const files = walk(want);
    const same = files.every((f) => fs.readFileSync(path.join(WS, f), "utf8").replace(/\n+$/, "") === fs.readFileSync(path.join(want, f), "utf8").replace(/\n+$/, ""));
    const extra = walk(WS).filter((f) => !files.includes(f) && f !== "package.json");
    ok(`${take}: files match ch${ch} (${files.length} files, ${((Date.now() - t0) / 1000).toFixed(1)}s)`, same && !extra.length);
    if (extra.length) console.log("   extra files:", extra);
    const checks = (log.match(/check ✅/g) || []).length;
    ok(`${take}: no errors, ${checks}/${files.length} checks passed`, !/✖|⚠️|differs|unknown command/.test(log) && checks === fs.readFileSync(path.join(T, "channel/takes", take), "utf8").split("\n").filter((l) => l.startsWith("check ")).length);
    if (/✖|⚠️|differs|unknown/.test(log)) console.log(log.split("\n").filter((l) => /✖|differs|unknown|\|/.test(l)).join("\n"));
    ok(`${take}: OBS started and stopped`, /OBS start/.test(log) && /OBS stop/.test(log) && !obs.recording);
  }
  ok("untouched project files survive restore", fs.existsSync(path.join(WS, "package.json")));
  ok("OBS saw StartRecord/StopRecord per take with good auth", obs.log.filter((x) => x === "StartRecord").length === takes.length && !obs.log.includes("bad auth"));
  obs.close();
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
