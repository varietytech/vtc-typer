// Runs the extension against a fake VS Code API:  node test/run-tests.js
// Checks: typing + paste + clear reproduce reference files exactly, terminal typing, read-only requests,
// and resuming a take after "openfolder" reloads the window.
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const T = path.join(os.tmpdir(), "vtc-test"); process.env.VTC_TEST_DIR = T;
fs.rmSync(T, { recursive: true, force: true });
for (const d of ["channel/takes", "channel/live", "src", "ws/app", "ws/sub"]) fs.mkdirSync(path.join(T, d), { recursive: true });
process.env.NODE_PATH = path.join(__dirname, "fake"); Module._initPaths();
const vscode = require("vscode");
const ext = require("../extension.js");
const ref = `import { Text, View } from 'react-native';\n\nexport default function Home() {\n  return (\n    <View style={{ flex: 1 }}>\n      <Text>Hello</Text>\n    </View>\n  );\n}`;
fs.writeFileSync(path.join(T, "src/index.tsx"), ref);
fs.writeFileSync(path.join(T, "ws/app/index.tsx"), "export default function Old() { return null; }\n");
const store = new Map(), cmds = {}; let opened = null;
vscode.commands.registerCommand = (n, f) => { cmds[n] = f; return { dispose() {} }; };
vscode.commands.executeCommand = async (c, uri) => { if (c === "vscode.openFolder") opened = uri.fsPath; };
const ctx = { subscriptions: [], globalState: { get: (k) => store.get(k), update: async (k, v) => store.set(k, v) } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
(async () => {
  fs.writeFileSync(path.join(T, "channel/takes/a.take"),
    "terminal npm run reset-project\nopen app/index.tsx\nclear\ntype index.tsx 1-5\npaste index.tsx 6-9\nsave\ncheck index.tsx\nworkspace sub\nopenfolder\nopen b.ts\ntext const b = 2;\nsave\n");
  ext.activate(ctx);
  fs.writeFileSync(path.join(T, "channel/live/request.json"), JSON.stringify({ id: "r1", action: "snapshot" }));
  await wait(2000);
  ok("read-only snapshot request answered", fs.existsSync(path.join(T, "channel/live/response-r1.json")));
  await cmds["vtc.play"]();
  for (let i = 0; i < 300 && !opened; i++) await wait(200);
  ok("typed + pasted file matches the reference", fs.readFileSync(path.join(T, "ws/app/index.tsx"), "utf8") === ref);
  ok("terminal command typed and run", vscode._term === "npm run reset-project\n");
  ok("openfolder asked VS Code to open the new folder", opened === path.join(T, "ws/sub"));
  ext.activate(ctx);                                    // simulate the window reload
  for (let i = 0; i < 80; i++) { await wait(250); const f = path.join(T, "ws/sub/b.ts"); if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("b = 2")) break; }
  ok("take resumed after the reload", fs.readFileSync(path.join(T, "ws/sub/b.ts"), "utf8") === "const b = 2;");
  ok("resume marker cleared at the end", store.get("vtc.resume") === undefined);
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
