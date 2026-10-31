// Minimal fake of the VS Code API, enough to test the typer without VS Code.
const fs = require("fs");
class Position { constructor(l,c){this.line=l;this.character=c;} translate(dl,dc){return new Position(this.line+dl,this.character+dc);} }
class Range { constructor(a,b,c,d){ if(a instanceof Position){this.start=a;this.end=b;} else {this.start=new Position(a,b);this.end=new Position(c,d);} } }
class Selection extends Range { constructor(a,b,c,d){ super(a,b,c,d); this.active=this.end; } }
class Doc { constructor(p){this.uri={fsPath:p}; this.lines=fs.readFileSync(p,"utf8").replace(/\r\n/g,"\n").split("\n"); this.isDirty=false;}
  get lineCount(){return this.lines.length;} lineAt(i){const t=this.lines[i]; return {text:t, range:new Range(new Position(i,0),new Position(i,t.length))};}
  getText(){return this.lines.join("\n");} async save(){fs.writeFileSync(this.uri.fsPath,this.getText()); this.isDirty=false; return true;} }
function off(doc,p){ return Math.min(p.line, doc.lines.length-1); }
class Editor { constructor(d){this.document=d; this.selection=new Selection(0,0,0,0);} revealRange(){}
  async edit(cb){ const d=this.document; cb({ insert:(pos,text)=>{ const l=d.lines[pos.line]; const parts=(l.slice(0,pos.character)+text+l.slice(pos.character)).split("\n"); d.lines.splice(pos.line,1,...parts); },
     delete:(r)=>{ const a=r.start,b=r.end; const bl=Math.min(b.line,d.lines.length-1); const tail = b.line>=d.lines.length? "" : d.lines[bl].slice(b.character); const joined=d.lines[a.line].slice(0,a.character)+tail; d.lines.splice(a.line,(b.line>=d.lines.length? d.lines.length : bl+1)-a.line,joined); } }); d.isDirty=true; return true; } }
const docs=[]; const editors=[];
const os=require("os"), path=require("path");
const T=process.env.VTC_TEST_DIR||path.join(os.tmpdir(),"vtc-test");
const cfgVals={channelFolder:path.join(T,"channel"), srcRoot:path.join(T,"src"), speed:+(process.env.VTC_SPEED||200), typos:0.02, obsPort:+(process.env.VTC_OBS_PORT||4455), obsPassword:process.env.VTC_OBS_PASSWORD||""};
module.exports = {
  Position, Range, Selection, version:"mock",
  StatusBarAlignment:{Left:1}, ThemeColor: class{}, TextEditorRevealType:{InCenterIfOutsideViewport:1},
  Uri:{file:(p)=>({fsPath:p})},
  workspace:{ getConfiguration:()=>({get:(k)=>cfgVals[k]}), workspaceFolders:[{uri:{fsPath:path.join(T,"ws")}}], get textDocuments(){return docs;},
    openTextDocument: async (p)=>{ let d=docs.find(x=>x.uri.fsPath===p); if(!d){d=new Doc(p); docs.push(d);} return d; } },
  window:{ createStatusBarItem:()=>({show(){},hide(){},dispose(){}}), get visibleTextEditors(){return editors;}, get activeTextEditor(){return editors[editors.length-1];},
    showTextDocument: async (d)=>{ let e=editors.find(x=>x.document===d); if(!e){e=new Editor(d); editors.push(e);} return e; },
    terminals:[], createTerminal:(o)=>{ const t={name:o.name, shellIntegration:{}, show(){}, sendText(s,nl){ module.exports._term += s + (nl?"\n":""); }}; module.exports.window.terminals.push(t); return t; },
    showInformationMessage(m){console.log("INFO:",m);}, showErrorMessage(m){console.log("ERROR:",m);}, showWarningMessage(m){console.log("WARN:",m);}, setStatusBarMessage(){}, showQuickPick: async(x)=>x[0] },
  languages:{ getDiagnostics:(u)=> u? [] : [] },
  commands:{ registerCommand:()=>({dispose(){}}), executeCommand: async(c)=>{ if(c==="workbench.action.closeAllEditors"){docs.length=0; editors.length=0;} } },
  _closeAll(){docs.length=0; editors.length=0;},
  _term:""
};
