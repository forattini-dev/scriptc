import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
const root = process.env.SCRIPTC_AUDIT_COMPILER || '/tmp/scriptc-redcode-identity-20260913';
const output = process.env.SCRIPTC_AUDIT_OUTPUT || '/tmp/scriptc-dependency-compliance-20260913';
const req = createRequire(root + '/packages/compiler/package.json');
const ts = req('typescript5');
const { resolveBareModule, resolveRelativeModule, setProjectRealm, clearResolveCaches } = await import(root + '/packages/compiler/src/frontend/resolve.ts');
const { npmStaticIneligibleReason, setNpmStaticPackages } = await import(root + '/packages/compiler/src/frontend/npm-static.ts');
const { setActiveRuntimeTarget, RUNTIME_TARGETS } = await import(root + '/packages/compiler/src/compat/runtime-target.ts');
const base = '/home/cyber/Work/reddb.io';
const repos = ['redcode', 'red-skills', 'red-dev'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const json = (file: string) => JSON.parse(read(file));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file: string, data: unknown) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2) + '\n');
const state = () => Object.fromEntries([root, ...repos.map(r => path.join(base, r))].map(p => [p, { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p, encoding: 'utf8' }).trim(), status: execFileSync('git', ['status', '--short'], { cwd: p, encoding: 'utf8' }) }]));
const before = state();
const hashes = new Map<string, string>();
const remember = (file: string) => { if (fs.existsSync(file) && !hashes.has(file)) hashes.set(file, sha(file)); };
const real = (file: string) => { try { return fs.realpathSync(file); } catch { return file; } };
const isDts = (file: string) => /\.d\.(ts|mts|cts)$/.test(file);
const language = (file: string | null) => !file ? 'unresolved' : isDts(file) ? 'declaration' : /\.(tsx?|mts|cts)$/.test(file) ? 'TypeScript' : /\.(jsx?|mjs|cjs)$/.test(file) ? 'JavaScript' : /\.node$/.test(file) ? 'native-addon' : 'asset-or-other';
const builtin = new Set([...builtinModules, ...builtinModules.map(x => 'node:' + x), 'bun', 'bun:ffi', 'bun:sqlite', 'bun:test']);
const packageName = (specifier: string) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const pkgCache = new Map<string, any>();
function owner(file: string): any {
  let dir = path.dirname(file);
  if (pkgCache.has(dir)) return pkgCache.get(dir);
  const trail: string[] = [];
  while (true) {
    trail.push(dir);
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try { const m = json(manifest); if (m.name) { remember(manifest); const p = { name: m.name, version: m.version || null, dir, manifest, data: m }; trail.forEach(t => pkgCache.set(t, p)); return p; } } catch {}
    }
    if (dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  trail.forEach(t => pkgCache.set(t, null)); return null;
}
const configCache = new Map<string, any>();
function options(file: string) {
  const config = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  if (!config) return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, allowImportingTsExtensions: true, resolveJsonModule: true };
  if (!configCache.has(config)) {
    remember(config);
    const parsed = ts.readConfigFile(config, ts.sys.readFile);
    const c = ts.parseJsonConfigFileContent(parsed.config || {}, ts.sys, path.dirname(config));
    configCache.set(config, { ...c.options, allowJs: true });
  }
  return configCache.get(config);
}
function installed(from: string, name: string) {
  for (let dir = path.dirname(from);;) {
    const m = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(m)) return owner(path.join(real(path.dirname(m)), '__audit__.ts'));
    if (dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}
const astCache = new Map<string, any>();
function imports(file: string) {
  if (astCache.has(file)) return astCache.get(file);
  remember(file);
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const found: any[] = []; const nonliteral: any[] = [];
  function visit(n: any) {
    let spec, kind, typeOnly = false;
    if (ts.isImportDeclaration(n)) { spec = n.moduleSpecifier; kind = 'import'; typeOnly = !!n.importClause?.isTypeOnly || (!!n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && n.importClause.namedBindings.elements.length > 0 && !n.importClause.name && n.importClause.namedBindings.elements.every((e: any) => e.isTypeOnly)); }
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier) { spec = n.moduleSpecifier; kind = 'export'; typeOnly = !!n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.length > 0 && n.exportClause.elements.every((e: any) => e.isTypeOnly)); }
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) { spec = n.moduleReference.expression; kind = 'import-equals'; typeOnly = !!n.isTypeOnly; }
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) { spec = n.arguments[0]; kind = n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require'; if (!spec || !ts.isStringLiteralLike(spec)) nonliteral.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, expression: n.getText(sf).slice(0, 180), kind }); }
    if (spec && ts.isStringLiteralLike(spec)) found.push({ specifier: spec.text, kind, typeOnly, line: sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1 });
    ts.forEachChild(n, visit);
  }
  visit(sf); const result = { imports: found, nonliteral }; astCache.set(file, result); return result;
}
const ambient: any[] = [];
for (const repo of repos) {
  const dir = path.join(base, repo);
  const files = execFileSync('git', ['ls-files', '-z', '*.d.ts', '*.d.mts', '*.d.cts'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const rel of files) { const file = path.join(dir, rel); if (!fs.existsSync(file)) continue; remember(file); const source = read(file); const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); const visit = (n: any) => { if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) ambient.push({ repo, specifier: n.name.text, file, anyTokens: (n.getText(sf).match(/\bany\b/g) || []).length, hasBody: !!n.body }); ts.forEachChild(n, visit); }; visit(sf); }
}
save('ambient-declarations.json', ambient);
const admission = json(root + '/.red/checkpoints/2026-09-13-native-consumer-builds/admission.json');
const entries = admission.rows.filter((r: any) => r.lane === 'default').map((r: any) => ({ id: r.id, entry: r.entry, target: r.target, evidenceDirectory: r.directory }));
entries.push({ id: 'redcode/redcode', entry: base + '/redcode/packages/redcode/src/index.ts', target: 'bun', evidenceDirectory: '/tmp/scriptc-redcode-native-proxy-20260913a' });
const edges: any[] = [], graphSummaries: any[] = [], nonliteral: any[] = [], packageRoots = new Map<string, any>();
for (const entry of entries) {
  setActiveRuntimeTarget(RUNTIME_TARGETS[entry.target]); setNpmStaticPackages([]); clearResolveCaches(); setProjectRealm(entry.entry);
  const repo = entry.id.split('/')[0]; const q: string[] = [entry.entry]; const visited = new Set<string>();
  // Captured runtime files supplement the entry traversal, including statically selected npm implementation files.
  const evidence = path.join(entry.evidenceDirectory, 'build.json');
  if (fs.existsSync(evidence)) { const d = json(evidence); for (const src of d.loadedSources || []) if (!isDts(src.file)) q.push(src.file); if (d.sources) for (const file of Array.isArray(d.sources) ? d.sources.map((s: any) => s.file) : Object.keys(d.sources)) if (file && !isDts(file)) q.push(file); }
  while (q.length) {
    const file = real(q.pop()!); if (visited.has(file) || !fs.existsSync(file) || !/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(file) || isDts(file)) continue; visited.add(file);
    const pkg = owner(file); if (pkg) packageRoots.set(pkg.dir, pkg);
    const parsed = imports(file); nonliteral.push(...parsed.nonliteral.map((x: any) => ({ program: entry.id, file, ...x })));
    for (const i of parsed.imports) {
      if (builtin.has(i.specifier) || i.specifier.startsWith('node:') || i.specifier.startsWith('bun:')) { edges.push({ program: entry.id, file, ...i, category: 'builtin' }); continue; }
      let resolved = ts.resolveModuleName(i.specifier, file, options(file), ts.sys).resolvedModule?.resolvedFileName || null;
      if (i.specifier.startsWith('.') || i.specifier.startsWith('/') || i.specifier.startsWith('#') || i.specifier.startsWith('@/') || i.specifier.startsWith('@test/')) {
        if (!resolved && i.specifier.startsWith('.')) resolved = resolveRelativeModule(file, i.specifier);
        if (resolved) { remember(resolved); if (!i.typeOnly && !resolved.includes('/node_modules/') && !isDts(resolved)) q.push(resolved); }
        edges.push({ program: entry.id, file, ...i, category: resolved ? 'project-or-alias' : 'unresolved-project-or-asset', resolved }); continue;
      }
      const name = packageName(i.specifier);
      const types = resolveBareModule(file, i.specifier);
      const runtime = resolveBareModule(file, i.specifier, 'js-only');
      const p = installed(file, name) || (runtime ? owner(runtime.typesFile) : null);
      if (p) packageRoots.set(p.dir, p);
      const declaration = types?.typesFile || null;
      if (declaration) remember(declaration); if (runtime) remember(runtime.typesFile); if (resolved) remember(resolved);
      const localAmbient = ambient.filter(x => x.repo === repo && x.specifier === i.specifier);
      let typing = declaration && isDts(declaration) ? declaration.includes('/@types/') ? 'external-types' : 'own-declarations' : declaration && language(declaration) === 'TypeScript' ? 'TypeScript-source' : localAmbient.length ? 'local-ambient-candidate' : 'no-declaration-resolved';
      const autoEligibilityApplies = !!p?.dir.includes('/node_modules/');
      const automaticRefusal = autoEligibilityApplies ? declaration ? npmStaticIneligibleReason(name, declaration, runtime?.typesFile || null) : 'no types/source surface resolved' : null;
      const e = { program: entry.id, file, ...i, category: 'package', package: name, version: p?.version || null, packageRoot: p?.dir || null, typesPath: declaration, typescriptResolved: resolved, runtimePath: runtime?.typesFile || null, runtimeLanguage: language(runtime?.typesFile || null), typing, localAmbientDeclarations: localAmbient.map(x => x.file), autoEligibilityApplies, automaticRefusal, autoEligibilityIsNotNativeBuildProof: true };
      edges.push(e);
      if (!i.typeOnly && runtime && !runtime.typesFile.includes('/node_modules/') && !isDts(runtime.typesFile)) q.push(runtime.typesFile);
    }
  }
  graphSummaries.push({ ...entry, filesScanned: visited.size, literalImports: edges.filter(e => e.program === entry.id).length, nonliteralImports: nonliteral.filter(e => e.program === entry.id).length });
  console.log(entry.id, 'files', visited.size, 'total package roots', packageRoots.size);
}
save('imports.json', edges); save('programs.json', graphSummaries); save('nonliteral-imports.json', nonliteral);
// Conservative manifest closure: includes declared runtime, optional and peer dependencies; it is NOT proof of runtime reachability.
const declarationEdges: any[] = [], packages: any[] = [], done = new Set<string>(); const pending = [...packageRoots.values()];
while (pending.length) {
  const p = pending.pop(); if (done.has(p.dir)) continue; done.add(p.dir);
  const pkgEdges = edges.filter(e => e.category === 'package' && e.packageRoot === p.dir);
  const from = path.join(p.dir, '__audit__.ts');
  let declaredTypes = p.data.types || p.data.typings || null;
  let ownTypeFiles = 0, sourceTsFiles = 0, sourceJsFiles = 0, nativeFiles = 0;
  // File extension inventory is evidence of published artifacts, not of the language used by authors.
  const dirs = [p.dir];
  while (dirs.length) { const dir = dirs.pop()!; for (const item of fs.readdirSync(dir, { withFileTypes: true })) { if (item.name === 'node_modules' || item.name === '.git') continue; const f = path.join(dir, item.name); if (item.isDirectory()) dirs.push(f); else if (item.isFile()) { if (isDts(f)) ownTypeFiles++; else if (/\.(tsx?|mts|cts)$/.test(f)) sourceTsFiles++; else if (/\.(jsx?|mjs|cjs)$/.test(f)) sourceJsFiles++; else if (/\.node$/.test(f)) nativeFiles++; } } }
  packages.push({ name: p.name, version: p.version, root: p.dir, workspace: !p.dir.includes('/node_modules/'), observedPrograms: [...new Set(pkgEdges.map(e => e.program))], observedRuntimeImport: pkgEdges.some(e => !e.typeOnly), observedSubpaths: [...new Set(pkgEdges.map(e => e.specifier))], manifestTypes: declaredTypes, ownDeclarationFiles: ownTypeFiles, shippedTsFiles: sourceTsFiles, shippedJsFiles: sourceJsFiles, nativeAddonFiles: nativeFiles, authoringLanguage: 'not inferred from published files', manifestSha256: sha(p.manifest), typeStatusAtObservedImports: [...new Set(pkgEdges.map(e => e.typing))], autoRefusalsAtObservedImports: [...new Set(pkgEdges.map(e => e.automaticRefusal).filter(Boolean))] });
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const [name, range] of Object.entries(p.data[field] || {})) { const child = installed(from, name); declarationEdges.push({ from: p.dir, fromName: p.name, name, range, field, installedRoot: child?.dir || null, installedVersion: child?.version || null, optionalPeer: !!p.data.peerDependenciesMeta?.[name]?.optional }); if (child && !done.has(child.dir)) pending.push(child); }
}
save('packages.json', packages); save('declared-dependency-edges.json', declarationEdges);
const after = state(); const changed = [...hashes].filter(([file, digest]) => !fs.existsSync(file) || sha(file) !== digest).map(([file]) => file);
save('source-hashes.json', Object.fromEntries(hashes));
save('provenance.json', { compiler: root, inventoryScriptSha256: sha(new URL(import.meta.url).pathname), before, after, gitStateUnchanged: JSON.stringify(before) === JSON.stringify(after), scannedFilesUnchanged: changed.length === 0, changedFiles: changed, scannedHashCount: hashes.size, generatedAt: new Date().toISOString(), scope: '18 original entries; static literal workspace import graph plus captured compiler runtime sources; npm manifest closure overapproximates dependency use; nonliteral imports are listed but not resolved; no installs, no native builds, no proof of full typing quality from declarations alone; standalone npm AUTO eligibility checked only for external package roots, because workspace eligibility requires program registry setup' });
const counts = (values: any[]) => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
save('inventory-summary.json', { programs: entries.length, scannedFiles: astCache.size, imports: edges.length, externalObservedPackages: new Set(edges.filter(e => e.category === 'package' && e.packageRoot?.includes('/node_modules/')).map(e => e.package)).size, packageInstancesInManifestClosure: packages.length, distinctPackageNamesInManifestClosure: new Set(packages.map(p => p.name)).size, observedImportTyping: counts(edges.filter(e => e.category === 'package').map(e => e.typing)), manifestClosureNoOwnDeclarationsOrTs: packages.filter(p => !p.workspace && p.ownDeclarationFiles === 0 && p.shippedTsFiles === 0).length, unresolvedManifestEdges: declarationEdges.filter(e => !e.installedRoot).length, nonliteralImports: nonliteral.length, provenanceUnchanged: changed.length === 0 && JSON.stringify(before) === JSON.stringify(after) });
console.log(read(path.join(output, 'inventory-summary.json')));
