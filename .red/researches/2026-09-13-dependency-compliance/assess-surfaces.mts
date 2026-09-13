import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.SCRIPTC_AUDIT_COMPILER || '/tmp/scriptc-redcode-identity-20260913';
const out = process.env.SCRIPTC_AUDIT_OUTPUT || '/tmp/scriptc-dependency-compliance-20260913';
const { resolveBareModule, clearResolveCaches } = await import(root + '/packages/compiler/src/frontend/resolve.ts');
const { setNpmStaticPackages } = await import(root + '/packages/compiler/src/frontend/npm-static.ts');
const { RUNTIME_TARGETS, setActiveRuntimeTarget } = await import(root + '/packages/compiler/src/compat/runtime-target.ts');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
const save = (f: string, v: unknown) => fs.writeFileSync(path.join(out, f), JSON.stringify(v, null, 2) + '\n');
const packages = read('packages.json'), imports = read('imports.json'), relations = read('declared-dependency-edges.json');
const typed = (f: string | null) => !!f && /\.(ts|tsx|mts|cts)$/.test(f);
const decl = (f: string | null) => !!f && /\.d\.(ts|mts|cts)$/.test(f);
const result: any[] = [];
setNpmStaticPackages([]);
for (const p of packages) {
  const observations = imports.filter((e: any) => e.category === 'package' && e.packageRoot === p.root);
  const parents = relations.filter((e: any) => e.installedRoot === p.root);
  const contexts = [...new Set<string>(parents.map((p: any) => path.join(p.from, '__scriptc_audit__.ts')))];
  const probes: any[] = [];
  for (const from of contexts) {
    const target = from.includes('/red-skills/') ? 'node24' : 'bun';
    setActiveRuntimeTarget(RUNTIME_TARGETS[target]); clearResolveCaches();
    const types = resolveBareModule(from, p.name)?.typesFile || null;
    const runtime = resolveBareModule(from, p.name, 'js-only')?.typesFile || null;
    let jsdocTags: string[] = [];
    if (runtime && /\.(js|jsx|cjs|mjs)$/.test(runtime)) {
      const source = fs.readFileSync(runtime, 'utf8');
      jsdocTags = [...new Set(source.match(/@(param|returns?|type|typedef|template|satisfies|implements)\b/g) || [])];
    }
    probes.push({ from, target, types, runtime, declarationResolved: decl(types), typedSourceResolved: typed(types) && !decl(types), externalTypes: !!types?.includes('/@types/'), jsdocTagsAtRuntimeEntry: jsdocTags });
  }
  const valid = probes.filter(p => p.declarationResolved || p.typedSourceResolved);
  const observedTyped = observations.filter((e: any) => typed(e.typesPath) || typed(e.typescriptResolved) || e.localAmbientDeclarations?.length);
  let evidence = p.workspace ? 'workspace' : p.name.startsWith('@types/') ? 'declaration-package' : valid.length || observedTyped.length ? 'type-surface-resolved-in-at-least-one-context' : p.ownDeclarationFiles || p.shippedTsFiles ? 'types-or-ts-files-present-but-root-unresolved' : probes.some(p => p.jsdocTagsAtRuntimeEntry.length) ? 'js-no-declarations-jsdoc-candidate' : 'js-or-native-no-declaration-found';
  result.push({ ...p, entryTypeEvidence: evidence, exactSubpathCaveat: 'Root/other-subpath typings do not type every imported subpath. See imports.csv.', parentContexts: contexts.length, typedParentContexts: valid.length, observedTypedImports: observedTyped.length, probeResults: probes, declarationOnlyDoesNotProveMinimumTypeQualityOrNativeSupport: true });
}
save('package-surfaces.json', result);
save('surface-summary.json', { generatedAt: new Date().toISOString(), scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'), count: result.length, byEvidence: Object.fromEntries([...new Set(result.map(p => p.entryTypeEvidence))].sort().map(k => [k, result.filter(p => p.entryTypeEvidence === k).length])), scope: 'Conservative runtime/optional/peer manifest closure; exact imported subpaths separately retained. Syntax and resolution metadata do not prove public any absence, compiler support or runtime reachability. No npm registry queries or installs.' });
console.log(fs.readFileSync(path.join(out, 'surface-summary.json'), 'utf8'));
