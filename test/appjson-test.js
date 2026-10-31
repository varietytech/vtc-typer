// chapter 1's app.json edit (setline / above / quoted text) on the real template app.json
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const T = path.join(os.tmpdir(), "vtc-appjson"); process.env.VTC_TEST_DIR = T; process.env.VTC_SPEED = "3000";
fs.rmSync(T, { recursive: true, force: true });
for (const d of ["channel/takes", "channel/live", "src", "ws/proj"]) fs.mkdirSync(path.join(T, d), { recursive: true });
fs.copyFileSync(process.argv[2], path.join(T, "ws/proj/app.json"));
fs.copyFileSync(process.argv[3], path.join(T, "channel/takes/c1.take"));
process.env.NODE_PATH = path.join(__dirname, "fake"); Module._initPaths();
const vscode = require("vscode"); const ext = require("../extension.js");
const cmds = {}; vscode.commands.registerCommand = (n, f) => { cmds[n] = f; return { dispose() {} }; };
let opened = null; vscode.commands.executeCommand = async (c, u) => { if (c === "vscode.openFolder") opened = u.fsPath; };
// skip the terminal/OBS parts: keep only the editor steps + workspace
const take = fs.readFileSync(path.join(T, "channel/takes/c1.take"), "utf8").split("\n")
  .filter((l) => /^(workspace|open|setline|above|text|save|openfolder)\b/.test(l)).join("\n").replace("workspace docuna-scan-101", "workspace proj");
fs.writeFileSync(path.join(T, "channel/takes/c1.take"), take);
const store = new Map();
ext.activate({ subscriptions: [], globalState: { get: (k) => store.get(k), update: async (k, v) => store.set(k, v) } });
(async () => {
  await cmds["vtc.play"]();
  while (!opened) await new Promise((r) => setTimeout(r, 100));
  const txt = fs.readFileSync(path.join(T, "ws/proj/app.json"), "utf8");
  const j = JSON.parse(txt);
  const pass = j.expo.name === "Docuna Scan 101" && j.expo.android.package === "com.varietytech.docunascan101" && opened.endsWith("proj");
  console.log(txt.split("\n").slice(0, 18).join("\n"));
  console.log(pass ? "PASS app.json edited and valid JSON" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
