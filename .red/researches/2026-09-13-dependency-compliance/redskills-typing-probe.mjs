import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from '/tmp/scriptc-redcode-identity-20260913/packages/compiler/node_modules/typescript5/lib/typescript.js';
import { loadProgram, checkPreflight } from '/tmp/scriptc-redcode-identity-20260913/packages/compiler/src/frontend/program.ts';
const root='/home/cyber/Work/reddb.io/red-skills';
const importer=root+'/apps/dev/src/core/toon-version.ts';
const localDts=root+'/apps/dev/src/types/js-yaml.d.ts';
const configFile=root+'/apps/dev/tsconfig.json';
const config=ts.readConfigFile(configFile,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configFile));
const require=createRequire(importer);
const result={compilerCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:'/tmp/scriptc-redcode-identity-20260913',encoding:'utf8'}).trim(), consumerCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),typescriptVersion:ts.version,importer,configFile,localDts,includedByConsumerTsconfig:parsed.fileNames.includes(localDts),nodeRequireResolution:require.resolve('js-yaml'),package:JSON.parse(fs.readFileSync(require.resolve('js-yaml/package.json'),'utf8'))};
try {result.installedTypesResolution=require.resolve('@types/js-yaml/package.json')}catch(e){result.installedTypesResolution={code:e.code}}
result.typescriptResolution=ts.resolveModuleName('js-yaml',importer,parsed.options,ts.sys).resolvedModule;
result.typescriptChecks=[];
for(const includeLocalDts of [false,true]){
 const p=ts.createProgram({rootNames:includeLocalDts?[importer,localDts]:[importer],options:{...parsed.options,noEmit:true}});
 const sf=p.getSourceFile(importer), checker=p.getTypeChecker();
 const imp=sf.statements.find(n=>ts.isImportDeclaration(n)&&n.moduleSpecifier.text==='js-yaml');
 result.typescriptChecks.push({includeLocalDts,semanticDiagnostics:p.getSemanticDiagnostics(sf).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),start:d.start})),yamlBindingType:checker.typeToString(checker.getTypeAtLocation(imp.importClause.name))});
}
const load=loadProgram(importer);
try{result.scriptc={diagnostics:checkPreflight(load),includesLocalDts:load.program.getSourceFiles().some(sf=>sf.fileName===localDts)}}finally{load.dispose()}
fs.writeFileSync('/tmp/scriptc-dependency-compliance-20260913/redskills-typing-probe.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
