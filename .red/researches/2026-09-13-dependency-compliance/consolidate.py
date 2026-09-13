from pathlib import Path
import json,csv,collections,hashlib,datetime

base=Path('/tmp/scriptc-dependency-compliance-20260913')
compiler=Path('/tmp/scriptc-redcode-identity-20260913')
read=lambda name:json.loads((base/name).read_text())
write=lambda name,value:(base/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
imports=read('imports.json'); packages=read('package-surfaces.json'); programs=read('programs.json')

def table(filename,rows,fields):
    with (base/filename).open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore',lineterminator='\n');w.writeheader()
        for row in rows:
            w.writerow({k:' | '.join(str(v) for v in row.get(k,[])) if isinstance(row.get(k),list) else row.get(k) for k in fields})

package_fields=['name','version','workspace','observedRuntimeImport','observedPrograms','observedSubpaths','entryTypeEvidence','typeStatusAtObservedImports','autoRefusalsAtObservedImports','parentContexts','typedParentContexts','ownDeclarationFiles','shippedTsFiles','shippedJsFiles','nativeAddonFiles','root','manifestSha256']
table('all-dependencies.csv',sorted(packages,key=lambda p:(p['name'],p['version'] or '',p['root'])),package_fields)
table('observed-dependencies.csv',sorted([p for p in packages if p['observedPrograms']],key=lambda p:(p['name'],p['version'] or '',p['root'])),package_fields)
table('transitive-unresolved-type-surfaces.csv',[p for p in packages if p['entryTypeEvidence'] in ['js-or-native-no-declaration-found','js-no-declarations-jsdoc-candidate','types-or-ts-files-present-but-root-unresolved']],package_fields)
table('unresolved-declared-dependencies.csv',[e for e in read('declared-dependency-edges.json') if not e['installedRoot']],['fromName','name','range','field','optionalPeer','from'])

# Deduplicate importer/subpath observations repeated across entrypoints.
groups={}
for e in imports:
    if e['category']!='package':continue
    key=(e['file'],e['line'],e['specifier'],e['typeOnly'],e['typesPath'],e['runtimePath'])
    if key not in groups:groups[key]={**e,'programs':[]}
    if e['program'] not in groups[key]['programs']:groups[key]['programs'].append(e['program'])
edges=list(groups.values())
fields=['package','version','specifier','programs','file','line','kind','typeOnly','typing','typesPath','typescriptResolved','runtimeLanguage','runtimePath','localAmbientDeclarations','autoEligibilityApplies','automaticRefusal']
table('imports.csv',sorted(edges,key=lambda x:(x['package'],x['specifier'],x['file'],x['line'])),fields)
suspects=[e for e in edges if e['typing']=='no-declaration-resolved' and e['runtimeLanguage']=='JavaScript']
table('observed-js-without-declarations.csv',suspects,fields)
table('available-external-types.csv',[e for e in edges if e['typing']=='external-types'],fields)

admission=json.loads((compiler/'.red/checkpoints/2026-09-13-native-consumer-builds/admission.json').read_text())
rows=[]; totals=collections.Counter()
for entry in admission['rows']:
    if entry['lane']!='default':continue
    d=Path(entry['directory'])/'build.json'; build=json.loads(d.read_text()) if d.exists() else {}; counts=collections.Counter(x['code'] for x in build.get('diagnostics',[]));totals.update(counts)
    rows.append({'program':entry['id'],'compilerCommit':admission['baselineCompilerCommit'],'status':entry['status'],'counts':dict(counts),'diagnosticOccurrences':sum(counts.values()),'npmStatic':'OFF','evidence':str(d)})
cli=json.loads(Path('/tmp/scriptc-redcode-native-proxy-20260913a/build.json').read_text());counts=collections.Counter(x['code'] for x in cli['diagnostics']);totals.update(counts)
rows.append({'program':'redcode/redcode','compilerCommit':'5e0830c24a73a2122b6ecec430c4d31b810de215','status':cli['status'],'counts':dict(counts),'diagnosticOccurrences':sum(counts.values()),'npmStatic':cli['options']['npmStatic'],'evidence':'/tmp/scriptc-redcode-native-proxy-20260913a/build.json'})
write('diagnostics-summary.json',{'scope':'Historical17 default entry attempts at f1087c plus latest full CLI at5e0830c; not a new all18 build, percentages and counts are not causal completion metrics.','programs':rows,'totalOccurrences':sum(totals.values()),'countsByCode':dict(totals)})

ext=[e for e in imports if e['category']=='package' and e['packageRoot'] and '/node_modules/' in e['packageRoot']]
external_types=sorted({e['package'] for e in ext if e['typing']=='external-types'})
missing=sorted({e['package'] for e in suspects})
summary={'scope':'Read-only inventory and causal audit for18 original entries; includes observed imports and separate conservative installed runtime/optional/peer manifest closure.','programCount':18,'uniqueSourceFilesScanned':read('inventory-summary.json')['scannedFiles'],'externalPackageNamesObserved':len({e['package'] for e in ext}),'externalPackageInstancesObserved':len({e['packageRoot'] for e in ext}),'externalNamesWithNonTypeOnlyImportSyntax':len({e['package'] for e in ext if not e['typeOnly']}),'declaredClosurePackageInstances':len(packages),'declaredClosureUniqueNames':len({p['name'] for p in packages}),'observedRuntimeJsPackagesWithoutResolvedDeclarations':missing,'observedRuntimeJsDistinctSubpathsWithoutResolvedDeclarations':len({e['specifier'] for e in suspects}),'observedPackagesWithAvailableExternalTypes':external_types,'conclusion':'Missing declarations exist but do not explain all build failures. Typed APIs, package admission, native foreign runtimes, omitted ambient declarations, inference and lowering gaps are independently evidenced.','typingDiscoveryRequirement':'type-discovery-requirement.md','consumerSourceChanges':False,'compilerImplementationChanges':False,'newFullNativeBuilds':False,'baselineDiagnosticsOccurrences':sum(totals.values()),'provenance':read('provenance.json'),'limitations':['Published JS does not establish author language.','Presence of d.ts alone does not prove full API type quality or native compliance.','Literal graph includes type-only and conditional imports; no runtime reachability guarantee.','28 nonliteral loads remain listed rather than guessed; assets/generated modules use separate consumer build steps.','Manifest closure intentionally overapproximates used dependencies; optional/peer/platform misses are not all install failures.','Declarations not available in checkout may exist in registry; registry candidates are separate and not automatically installed or trusted.','No percentage of3090 current CLI diagnostics can be assigned causally to missing typings from this audit.']}
write('summary.json',summary)
print(json.dumps({k:v for k,v in summary.items() if k not in ['provenance','limitations']},indent=2,ensure_ascii=False))
