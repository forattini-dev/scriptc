import ts from '/tmp/scriptc-redcode-identity-20260913/node_modules/typescript/lib/typescript.js';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, extname } from 'node:path';
import { builtinModules } from 'node:module';
const root='/home/cyber/Work/reddb.io/red-dev';
const output='/tmp/scriptc-dependency-compliance-20260913/reddev-probe.json';
const config=ts.readConfigFile(root+'/tsconfig.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const virtual=root+'/src/__scriptc_compliance_virtual_probe.ts';
const source=`import { createCLI } from 'cli-args-parser';\nimport { Box, Text, renderToString, prompt } from 'tuiuiu.js';\nimport { createWizard } from 'tuiuiu.js/hooks';\nimport font from '../assets/fonts/redwall-firacode-subset.ttf' with { type: 'file' };\nimport shell from '../config/bash/rc.sh' with { type: 'text' };\nimport configToml from '../config/bash/starship.toml' with { type: 'text' };\nexport { createCLI, Box, Text, renderToString, prompt, createWizard, font, shell, configToml };\n`;
const opts={...parsed.options,noEmit:true,skipLibCheck:true};
function probe(includeShims, explicitBun=false){
 const activeOptions=explicitBun?{...opts,types:['bun']}:opts;
 const host=ts.createCompilerHost(activeOptions);
 host.getCurrentDirectory=()=>root;
 const get=host.getSourceFile.bind(host),read=host.readFile.bind(host),exist=host.fileExists.bind(host);
 host.fileExists=f=>f===virtual||exist(f);host.readFile=f=>f===virtual?source:read(f);
 host.getSourceFile=(f,...args)=>f===virtual?ts.createSourceFile(f,source,ts.ScriptTarget.Latest,true):get(f,...args);
 const roots=[virtual,...(includeShims?[root+'/src/shims.d.ts']:[])];
 const program=ts.createProgram(roots,activeOptions,host),checker=program.getTypeChecker(),sf=program.getSourceFile(virtual);
 const imports=[];
 for(const s of sf.statements){if(!ts.isImportDeclaration(s)||!s.importClause)continue;
  const bindings=[];if(s.importClause.name)bindings.push(s.importClause.name);
  if(s.importClause.namedBindings&&ts.isNamedImports(s.importClause.namedBindings))for(const b of s.importClause.namedBindings.elements)bindings.push(b.name);
  const resolved=ts.resolveModuleName(s.moduleSpecifier.text,virtual,activeOptions,host).resolvedModule;
  imports.push({specifier:s.moduleSpecifier.text,resolved:resolved?.resolvedFileName??null,bindings:bindings.map(n=>{const t=checker.getTypeAtLocation(n),sym=checker.getSymbolAtLocation(n),actual=sym&&(sym.flags&ts.SymbolFlags.Alias)?checker.getAliasedSymbol(sym):sym;return {name:n.text,type:checker.typeToString(t,undefined,ts.TypeFormatFlags.NoTruncation),isAny:!!(t.flags&ts.TypeFlags.Any),declarations:(actual?.declarations??[]).map(d=>({file:d.getSourceFile().fileName,line:d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line+1}))};})});
 }
 const diagnostics=program.getSemanticDiagnostics(sf).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),line:sf.getLineAndCharacterOfPosition(d.start??0).line+1}));
 return {includeShims,explicitBun,optionDiagnostics:program.getOptionsDiagnostics().map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})),roots,shimsInProgram:program.getSourceFiles().some(f=>f.fileName===root+'/src/shims.d.ts'),imports,diagnostics};
}
function edges(file){
 const sf=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.js')?ts.ScriptKind.JS:ts.ScriptKind.TS),list=[];
 function walk(n){
  if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier))list.push({specifier:n.moduleSpecifier.text,kind:ts.isImportDeclaration(n)?'import':'export',line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,typeOnly:!!n.isTypeOnly||!!n.importClause?.isTypeOnly});
  if(ts.isCallExpression(n)&&((n.expression.kind===ts.SyntaxKind.ImportKeyword)||(ts.isIdentifier(n.expression)&&n.expression.text==='require'))){const a=n.arguments[0];list.push({specifier:a&&ts.isStringLiteralLike(a)?a.text:null,expression:a?sf.text.slice(a.pos,a.end).trim():null,kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamicImport':'require',line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,typeOnly:false});}
  ts.forEachChild(n,walk);
 }walk(sf);return list;
}
const loaded=JSON.parse(readFileSync('/tmp/scriptc-all-binary-admission-20260913/red-dev__red-dev__auto/build.json','utf8')).loadedSources.map(x=>x.file);
const actualImports=[];
for(const file of loaded)for(const e of edges(file))if(e.specifier&&!e.specifier.startsWith('.')&&!e.specifier.startsWith('/'))actualImports.push({file,...e});
const packages=[];
for(const name of ['cli-args-parser','tuiuiu.js']){
 const dir=realpathSync(root+'/node_modules/'+name),manifest=JSON.parse(readFileSync(dir+'/package.json','utf8'));
 const importedSubpaths=[...new Set(actualImports.filter(e=>e.specifier===name||e.specifier.startsWith(name+'/')).map(e=>e.specifier))].sort();
 const runtimeEntries=importedSubpaths.map(spec=>{const sub=spec===name?'.':'.'+spec.slice(name.length),exp=manifest.exports[sub];return resolve(dir,typeof exp==='string'?exp:exp.import??exp.default);});
 const queue=[...runtimeEntries],seen=new Set(),moduleEdges=[],unresolved=[];
 while(queue.length){const file=queue.pop();if(seen.has(file))continue;seen.add(file);if(!existsSync(file)){unresolved.push(file);continue;}for(const e of edges(file)){const row={file,...e};moduleEdges.push(row);if(e.specifier?.startsWith('.')){const target=resolve(dirname(file),e.specifier);if(existsSync(target))queue.push(target);else unresolved.push(target);}}}
 const bare=moduleEdges.filter(e=>e.specifier&&!e.specifier.startsWith('.')&&!e.specifier.startsWith('/')).map(e=>({...e,builtin:e.specifier.startsWith('node:')||builtinModules.includes(e.specifier)}));
 const anyDeclarations=[];const declarationPaths=importedSubpaths.map(spec=>{const sub=spec===name?'.':'.'+spec.slice(name.length),e=manifest.exports[sub];return resolve(dir,typeof e==='object'?e.types:manifest.types);});
 for(const file of declarationPaths){const sf=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);const hits=[];function walk(n){if(n.kind===ts.SyntaxKind.AnyKeyword)hits.push(sf.getLineAndCharacterOfPosition(n.getStart()).line+1);ts.forEachChild(n,walk);}walk(sf);anyDeclarations.push({file,anyKeywordCount:hits.length,lines:hits});}
 packages.push({name,version:manifest.version,dir,manifestPath:dir+'/package.json',declaredRuntimeDependencies:manifest.dependencies??{},optionalDependencies:manifest.optionalDependencies??{},peerDependencies:manifest.peerDependencies??{},importedSubpaths,runtimeEntries,ownDeclarations:declarationPaths,entryDeclarationAnyKeywords:anyDeclarations,moduleGraph:{scope:'Conservative syntax-level module reachability from actual imported package entrypoints; includes barrel exports and conditional imports, not function reachability or bundler tree shaking.',files:[...seen].sort(),moduleCount:seen.size,bareEdges:bare,externalPackageEdges:bare.filter(e=>!e.builtin),nonliteralEdges:moduleEdges.filter(e=>e.specifier===null),unresolvedRelative:unresolved}});
}
const result={typescript:ts.version,config:root+'/tsconfig.json',configuredShimsIncluded:parsed.fileNames.includes(root+'/src/shims.d.ts'),virtualEntry:virtual,virtualSource:source,virtualEntryWritten:false,withShims:probe(true),withoutShims:probe(false),withShimsAndInstalledBunSurface:probe(true,true),typeDirectives:['bun-types','bun'].map(name=>({name,resolution:ts.resolveTypeReferenceDirective(name,virtual,opts,ts.sys).resolvedTypeReferenceDirective??null})),consumerImports:actualImports,packages};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,typescript:ts.version,withShims:result.withShims.imports.map(x=>({specifier:x.specifier,types:x.bindings.map(b=>({name:b.name,isAny:b.isAny,type:b.type.length>180?b.type.slice(0,180)+'…':b.type}))})),withShimsDiagnostics:result.withShims.diagnostics,withoutShimsDiagnostics:result.withoutShims.diagnostics,packages:packages.map(p=>({name:p.name,version:p.version,importedSubpaths:p.importedSubpaths,runtimeDependencies:p.declaredRuntimeDependencies,moduleCount:p.moduleGraph.moduleCount,externals:p.moduleGraph.externalPackageEdges,builtinSpecifiers:[...new Set(p.moduleGraph.bareEdges.map(e=>e.specifier))],nonliteral:p.moduleGraph.nonliteralEdges}))},null,2));
