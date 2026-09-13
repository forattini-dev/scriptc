import { writeFileSync } from 'node:fs';
import { resolveBareModule } from '/tmp/scriptc-redcode-identity-20260913/packages/compiler/src/frontend/resolve.ts';
import { npmStaticIneligibleReason } from '/tmp/scriptc-redcode-identity-20260913/packages/compiler/src/frontend/npm-static.ts';
const from='/home/cyber/Work/reddb.io/red-dev/src/cli.ts';
const specs=['cli-args-parser','tuiuiu.js','tuiuiu.js/hooks'];
const results=specs.map(specifier=>{const declarations=resolveBareModule(from,specifier),runtime=resolveBareModule(from,specifier,'js-only');return {specifier,from,declarations,runtime,ineligibleReason:declarations?npmStaticIneligibleReason(declarations.packageName,declarations.typesFile,runtime?.typesFile??null):'no declaration resolution'};});
writeFileSync('/tmp/scriptc-dependency-compliance-20260913/npm-eligibility.json',JSON.stringify({scope:'Current compiler resolver plus auto eligibility heuristic only; not a compile or proof that lowering/admission will pass',results},null,2)+'\n');console.log(JSON.stringify(results,null,2));
