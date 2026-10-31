
const fs=require("fs"),os=require("os"),path=require("path"),Module=require("module");
const T=path.join(os.tmpdir(),"vtc-test2"); process.env.VTC_TEST_DIR=T; fs.rmSync(T,{recursive:true,force:true});
for (const d of ["channel/takes","channel/live","src","ws"]) fs.mkdirSync(path.join(T,d),{recursive:true});
process.env.NODE_PATH=path.join(__dirname,"fake"); Module._initPaths();
const vscode=require("vscode"); let startCb=null;
vscode.window.onDidStartTerminalShellExecution=(cb)=>{startCb=cb;return{dispose(){}}};
vscode.window.onDidEndTerminalShellExecution=()=>({dispose(){}});
const ext=require("../extension.js"); const cmds={};
vscode.commands.registerCommand=(n,f)=>{cmds[n]=f;return{dispose(){}}};
const ctx={subscriptions:[],globalState:{get:()=>undefined,update:async()=>{}}};
fs.writeFileSync(path.join(T,"channel/takes/p.take"),'terminal npm run reset-project\nwaitout "instead of deleting them"\nterminal n\n');
(async()=>{ ext.activate(ctx); await cmds["vtc.play"]();
  await new Promise(r=>setTimeout(r,800));
  startCb({terminal:{name:"VTC"},execution:{commandLine:{value:"npm run reset-project"},read:async function*(){ yield "> reset-project\r\n"; yield "Do you want to move existing files to /app-example instead of deleting them? (Y/n): "; await new Promise(r=>setTimeout(r,5000)); }}});
  for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,200)); if(vscode._term.includes("n\n") && vscode._term.split("\n").length>2) break; }
  const log=fs.readFileSync(path.join(T,"channel/live/log.txt"),"utf8");
  console.log(log.includes('saw "instead of deleting them"') && vscode._term.endsWith("n\n") ? "PASS  prompt without newline detected, answered n" : "FAIL  prompt detection\n"+log);
  process.exit(0); })();
