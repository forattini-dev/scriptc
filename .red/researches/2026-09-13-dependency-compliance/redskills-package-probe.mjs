import fs from 'node:fs';import path from 'node:path';import { createRequire } from 'node:module';
import ts from '/tmp/scriptc-redcode-identity-20260913/packages/compiler/node_modules/typescript5/lib/typescript.js';
const evidence='/tmp/scriptc-all-binary-admission-20260913';const entries=fs.readdirSync(evidence).filter(n=>n.startsWith('red-skills__')&&n.endsWith('__default'));
const packages=new Map();
for(const entry of entries){const build=JSON.parse(fs.readFileSync(`${evidence}/${entry}/build.json`));
 for(const d of build.diagnostics??[]){if(d.code!=='SC2013')continue;const name=/(?:importing |from the )'([^']+)'/.exec(d.message)?.[1];if(!name)continue;
  if(!packages.has(name)){const sf=ts.createSourceFile(d.loc.file,fs.readFileSync(d.loc.file,'utf8'),ts.ScriptTarget.Latest,true);const imp=sf.statements.find(s=>ts.isImportDeclaration(s)&&(s.moduleSpecifier.text===name||s.moduleSpecifier.text.startsWith(name+'/')));packages.set(name,{name,importer:d.loc.file,specifier:imp?.moduleSpecifier.text??name,diagnosticOccurrences:0,programs:[]});}
  const row=packages.get(name);row.diagnosticOccurrences++;if(!row.programs.includes(build.id))row.programs.push(build.id);
 }
}
const rows=[];
for(const row of packages.values()){
 const require=createRequire(row.importer);try {row.requireRuntime=require.resolve(row.specifier)}catch(e){row.requireRuntimeError={code:e.code,message:e.message}}
 const c=ts.findConfigFile(path.dirname(row.importer),ts.sys.fileExists);const config=c?ts.parseJsonConfigFileContent(ts.readConfigFile(c,ts.sys.readFile).config,ts.sys,path.dirname(c)).options:{};
 row.typesResolution=ts.resolveModuleName(row.specifier,row.importer,{...config,moduleResolution:ts.ModuleResolutionKind.NodeNext,module:ts.ModuleKind.NodeNext},ts.sys,undefined,undefined,ts.ModuleKind.ESNext).resolvedModule??null;
 const first=row.typesResolution?.resolvedFileName??row.requireRuntime;
 if(first){let dir=path.dirname(fs.realpathSync(first));while(dir!==path.dirname(dir)){const p=path.join(dir,'package.json');if(fs.existsSync(p)){const m=JSON.parse(fs.readFileSync(p));if(m.name===row.name){row.packagePath=p;row.version=m.version;row.types=m.types??m.typings??null;row.exports=m.exports??null;row.main=m.main??null;row.packageRoot=dir;row.workspace=!dir.includes('/node_modules/');row.rootTypeScriptFiles=fs.readdirSync(dir).filter(n=>/\.tsx?$/.test(n));break}}dir=path.dirname(dir)}}
 rows.push(row);
}
fs.writeFileSync('/tmp/scriptc-dependency-compliance-20260913/redskills-package-probe.json',JSON.stringify({scope:'Distinct packages mentioned by SC2013 in 13 default historical attempts; not full dependency inventory',rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({name,version,specifier,typesResolution,requireRuntime,diagnosticOccurrences,workspace})=>({name,version,specifier,typesPath:typesResolution?.resolvedFileName,requireRuntime,diagnosticOccurrences,workspace})),null,2));
