// A failing terminal command must stop the take and put the (cleaned) error output in the log.
const fs=require("fs"),os=require("os"),path=require("path"),Module=require("module");
const T=path.join(os.tmpdir(),"vtc-test3"); process.env.VTC_TEST_DIR=T; fs.rmSync(T,{recursive:true,force:true});
for (const d of ["channel/takes","channel/live","src","ws"]) fs.mkdirSync(path.join(T,d),{recursive:true});
process.env.NODE_PATH=path.join(__dirname,"fake"); Module._initPaths();
const vscode=require("vscode"); let startCb=null, endCb=null;
vscode.window.onDidStartTerminalShellExecution=(cb)=>{startCb=cb;return{dispose(){}}};
vscode.window.onDidEndTerminalShellExecution=(cb)=>{endCb=cb;return{dispose(){}}};
const ext=require("../extension.js"); const cmds={};
vscode.commands.registerCommand=(n,f)=>{cmds[n]=f;return{dispose(){}}};
const ctx={subscriptions:[],globalState:{get:()=>undefined,update:async()=>{}}};
fs.writeFileSync(path.join(T,"channel/takes/f.take"),"terminal npx create-expo-app@latest docuna-scanner\nwaitdone 60\nterminal cd docuna-scanner\n");
(async()=>{ ext.activate(ctx); await cmds["vtc.play"]();
  for (let i=0;i<100 && !vscode._term.includes("\n");i++) await new Promise(r=>setTimeout(r,50));   // command typed + Enter
  const exec={commandLine:{value:"npx create-expo-app@latest docuna-scanner"},read:async function*(){
    yield "\x1b]0;npm exec create-expo-app\x1b\\⠙⠹⠸";
    yield "\r\nThe directory docuna-scanner has files that might be overwritten:\r\n  package.json\r\n"; }};
  startCb({terminal:{name:"VTC"},execution:exec});
  await new Promise(r=>setTimeout(r,300));
  endCb({execution:exec,exitCode:1});
  await new Promise(r=>setTimeout(r,6000));
  const log=fs.readFileSync(path.join(T,"channel/live/log.txt"),"utf8");
  const stopped=!vscode._term.includes("cd docuna-scanner");
  const shown=log.includes("has files that might be overwritten") && !log.includes("\x1b");
  console.log(stopped ? "PASS  take stopped after the failed command" : "FAIL  take carried on after failure");
  console.log(shown ? "PASS  real error text logged, terminal codes removed" : "FAIL  error text missing\n"+log);
  process.exit(stopped && shown ? 0 : 1); })();
