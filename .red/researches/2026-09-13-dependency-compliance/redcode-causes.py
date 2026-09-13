import collections
import hashlib
import json
import pathlib
import re

OUT = pathlib.Path('/tmp/scriptc-dependency-compliance-20260913')
ROOT = pathlib.Path('/home/cyber/Work/reddb.io/redcode')
EVIDENCE = pathlib.Path('/tmp/scriptc-redcode-native-proxy-20260913a')
build = json.loads((EVIDENCE / 'build.json').read_text())
captured = {s['file']: s['text'] for s in json.loads((EVIDENCE / 'source-capture.json').read_text())['sources']}
diagnostics = build['diagnostics']

def package_of(spec):
    return '/'.join(spec.split('/')[:2]) if spec.startswith('@') else spec.split('/')[0]

def locate_package(pkg, files):
    for file in files:
        for parent in pathlib.Path(file).parents:
            candidate = parent / 'node_modules' / pkg / 'package.json'
            if candidate.is_file():
                return candidate.resolve(), 'importer-ancestor'
    declaration_wrappers = {'axe-core': '@axe-core/playwright', '@smithy/types': '@smithy/eventstream-codec'}
    wrapper = declaration_wrappers.get(pkg)
    if wrapper:
        parent_pkg, _ = locate_package(wrapper, files)
        if parent_pkg:
            for parent in parent_pkg.parents:
                candidate = parent / 'node_modules' / pkg / 'package.json'
                if candidate.is_file():
                    return candidate.resolve(), 'transitive-declaration-through-' + wrapper
    candidates = list((ROOT / 'node_modules/.bun').glob('*/node_modules/' + pkg + '/package.json'))
    unique = sorted(set(p.resolve() for p in candidates))
    return (unique[0], 'unique-installed-package-not-proven-resolution') if len(unique) == 1 else (None, f'{len(unique)} installed candidates')

def site(d):
    loc = d['loc']
    text = captured.get(loc['file'], '')
    prefix = text.encode('utf-16-le')[:loc['start'] * 2].decode('utf-16-le', errors='replace')
    suffix = text.encode('utf-16-le')[loc['start'] * 2:loc['end'] * 2].decode('utf-16-le', errors='replace')
    return dict(d, line=prefix.count('\n') + 1, source_excerpt=suffix[:500])

groups = collections.defaultdict(list)
local = []
for d in diagnostics:
    if d['code'] != 'SC2013':
        continue
    spec = re.search("^(?:values from the|importing) '([^']+)'", d['message']).group(1)
    if spec.startswith('.') or spec.startswith('@/'):
        local.append(d)
    else:
        groups[package_of(spec)].append((spec, d))

rows = []
for pkg, items in sorted(groups.items()):
    pj, resolution_note = locate_package(pkg, [d['loc']['file'] for _, d in items])
    row = {'diagnostic_owner': pkg, 'diagnostic_labels': sorted(set(s for s, _ in items)),
           'SC2013_occurrences': len(items), 'examples': [site(d) for _, d in items[:3]],
           'package_location_method': resolution_note}
    if pj:
        meta = json.loads(pj.read_text())
        declarations = sorted(pj.parent.rglob('*.d.ts')) + sorted(pj.parent.rglob('*.d.mts')) + sorted(pj.parent.rglob('*.d.cts'))
        declarations = [p for p in declarations if 'node_modules' not in p.relative_to(pj.parent).parts]
        ts_sources = [p for p in sorted(pj.parent.rglob('*.ts')) if not p.name.endswith('.d.ts') and 'node_modules' not in p.relative_to(pj.parent).parts]
        runtime_pkg = pkg
        if pkg.startswith('@types/'):
            bare = pkg[len('@types/'):]
            runtime_pkg = '@' + bare.replace('__', '/', 1) if '__' in bare else bare
        runtime_pj, runtime_note = locate_package(runtime_pkg, [d['loc']['file'] for _, d in items])
        runtime_meta = json.loads(runtime_pj.read_text()) if runtime_pj else {}
        row.update(package_json=str(pj), version=meta.get('version'), types_field=meta.get('types', meta.get('typings')),
                   main_field=meta.get('main'), exports=meta.get('exports'),
                   declaration_file_count=len(declarations), declaration_examples=[str(p) for p in declarations[:5]],
                   executable_ts_file_count=len(ts_sources), executable_ts_examples=[str(p) for p in ts_sources[:3]],
                   runtime_package=runtime_pkg, runtime_version=runtime_meta.get('version'),
                   runtime_package_json=str(runtime_pj) if runtime_pj else None,
                   runtime_package_location_method=runtime_note,
                   selected_npm_static=runtime_pkg in build['options']['npmStatic'])
        if pkg.startswith('@types/'):
            row.update(typing_class='third-party-declarations-present', owner='scriptc-admission-and-runtime',
                       cause='Typed authoring through installed @types; auto admission excludes third-party declarations. Latest explicit package list did not select this runtime.')
        elif pkg == '@npmcli/config':
            row.update(typing_class='confirmed-missing-declarations-at-used-imports', owner='consumer-or-package-for-contract;scriptc-for-native-runtime',
                       cause='Two imports suppressed with @ts-expect-error in core/src/npm-config.ts. A narrow checked declaration/adapter is missing; adding one alone does not establish native body support.')
        elif ts_sources or declarations:
            row.update(typing_class='own-declarations-or-executable-ts-present', owner='scriptc-admission-lowering-runtime',
                       cause='SC2013 is a native admission/fallback diagnostic, not evidence of missing typings. Bodies and transitive APIs still require compiler support.')
        else:
            row.update(typing_class='needs-manual-resolution', owner='undetermined')
    rows.append(row)

effect_ds = [d for d in diagnostics if d['code'] == 'SC1090' and ('effect kernel' in d['message'] or 'Schema.Struct over a non-literal' in d['message'])]
compiler_examples = []
for fragment in ['the effect kernel supports only literal concurrency', 'object spread after explicit properties', "rest parameter 'items'", 'WeakMap<AnyTool', 'checker crashed']:
    match = next((d for d in diagnostics if fragment in d['message']), None)
    if match:
        compiler_examples.append(site(match))

result = {
    'scope': 'Cause audit of latest original complete Redcode CLI refusal. Exhaustive SC2013 labels only; root unified inventory covers all18 and packages without an emitted diagnostic.',
    'compiler_source_commit': '5e0830c24a73a2122b6ecec430c4d31b810de215',
    'consumer_commit': 'b8fa0e8e31cd6dac384347f4852fc7b3c8519a86',
    'build_evidence': str(EVIDENCE / 'build.json'),
    'build_evidence_sha256': hashlib.sha256((EVIDENCE / 'build.json').read_bytes()).hexdigest(),
    'entry': build['entry'], 'options': build['options'],
    'diagnostic_occurrences': len(diagnostics), 'counts_by_code': dict(collections.Counter(d['code'] for d in diagnostics)),
    'SC2013': {'occurrences': 643, 'relative_or_at_alias_propagations': len(local),
               'named_label_occurrences': sum(len(v) for v in groups.values()),
               'distinct_named_labels': len(set(s for items in groups.values() for s, _ in items)),
               'distinct_diagnostic_package_owners': len(groups)},
    'effect_kernel_diagnostic_occurrences': len(effect_ds),
    'compiler_gap_examples': compiler_examples,
    'confirmed_missing_typing_candidates_in_SC2013': ['@npmcli/config', '@npmcli/config/lib/definitions/index.js'],
    'typing_caveats': [
        'These are diagnostic occurrences, not independent defects; SC2004 and local SC2013 often cascade.',
        'SC2013 includes declarations package identity and propagated workspace imports; do not count @types packages as runtime libraries.',
        'Shipped JavaScript does not establish the language in which a package was authored.',
        'An own .d.ts or local shim establishes a typing surface, not implementation correctness or static compilation success.',
        'unknown is an explicit safe type; its occurrence is not missing minimum typing.',
        'No full consumer typecheck, dependency reinstall or compiler build was performed during this audit.',
        'No percentage of the3090 diagnostics can be causally assigned to missing types from this evidence alone.'
    ],
    'local_typed_shims': [
        {'package': 'ssh2', 'declaration': str(ROOT / 'packages/core/src/capability/shell/ssh2.d.ts'), 'status': 'concrete-local-API-declarations'},
        {'package': 'gifenc', 'declaration': str(ROOT / 'packages/core/src/design/gifenc.d.ts'), 'status': 'concrete-local-API-declarations', 'note': 'worker edge requires separate reachability inventory; do not infer CLI admission from shim existence'}
    ],
    'packages': rows,
}
imports_path = OUT / 'imports.json'
if imports_path.exists():
    imports = json.loads(imports_path.read_text())
    missing = [r for r in imports if r.get('program') == 'redcode/redcode' and r.get('typing') == 'no-declaration-resolved']
    missing_runtime = [r for r in missing if r.get('runtimePath') and r.get('runtimeLanguage') == 'JavaScript']
    result['observed_untyped_import_edges'] = missing_runtime
    result['observed_untyped_package_roots'] = sorted(set(r['package'] for r in missing_runtime))
    result['non_javascript_asset_or_generated_imports_without_resolution'] = [r for r in missing if r not in missing_runtime]
    result['observed_import_inventory_source'] = str(imports_path)
    result['observed_import_inventory_sha256'] = hashlib.sha256(imports_path.read_bytes()).hexdigest()
    result['untyped_boundary_notes'] = [
        {'specifier': '@parcel/watcher/wrapper', 'consumer_file': str(ROOT / 'packages/core/src/filesystem/watcher.ts'),
         'import_line': 4, 'suppression_line': 3, 'assertion_line': 32,
         'consumer_contract': "createWrapper(binding) as typeof import('@parcel/watcher'); lazy callback has this typed return facade, but no typed input/body or runtime assertion",
         'independent_native_gap': 'computed require of platform-specific native addon; Effect.context/runForkWith/forkScoped and Promise.allSettled also refused in the same module',
         'owner': 'consumer-or-package-for-private-subpath-contract;scriptc-for-native-addon-and-async-APIs'},
        {'specifier': '@npmcli/config', 'consumer_file': str(ROOT / 'packages/core/src/npm-config.ts'),
         'import_lines': [5, 7], 'suppression_lines': [4, 6],
         'consumer_contract': 'config.flat cast to Record<string, unknown>; constructor/load/private definitions inputs remain undeclared',
         'independent_native_gap': 'class body and transitive module/runtime support still required after a declaration is supplied',
         'owner': 'consumer-or-package-for-private-API-contract;scriptc-for-runtime-body'}
    ]
    next(r for r in rows if r['diagnostic_owner'] == '@parcel/watcher')['known_untyped_subpaths'] = ['@parcel/watcher/wrapper']
    result['confirmed_missing_typing_candidates_in_SC2013'].append('@parcel/watcher/wrapper')
(OUT / 'redcode-causes.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'owners': len(rows), 'typing_classes': dict(collections.Counter(r.get('typing_class', 'unresolved') for r in rows)), 'effect_kernel_occurrences': len(effect_ds)}, indent=2))
