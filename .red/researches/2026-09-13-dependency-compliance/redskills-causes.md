# Red-skills: dependency typings versus native Rust refusal

The evidence does not support missing TypeScript/typings as the main explanation. In 13 original entry attempts, the sole missing-declaration diagnostic is js-yaml, for which the consumer already supplies the minimum declaration. Scriptc fails to include it.

## Provenance and scope

- Consumer: `c5255e006318fa3ec9aea51ccac11778da3888a1`, clean.
- Historical full entry attempts: compiler `f1087c892c9fb38ad41c712417284be98dadfe7d`; default `npmStatic` OFF, Rust/no engine.
- Fresh focused importer preflight: compiler `30cde1be34c0eddc7d6a4a808796f5c56c851d58`.
- Revalidated 1,638 recorded source occurrences against current disk, zero mismatches.
- Historical 1,759 diagnostics include cascades/instantiations; they are not independent bugs or an estimate of percentage complete. All 13 entries were not recompiled now.

## Causal findings

| Evidence | Finding | Ownership / next action |
|---|---|---|
| 1 SC0001 in dev | js-yaml 4.3.0 ships JS/no bundled declarations; @types/js-yaml not installed. Existing consumer `apps/dev/src/types/js-yaml.d.ts` already types `load(string): unknown` and is included by its tsconfig. Scriptc drops that root. | Fix scriptc ambient root adoption. Do not prescribe an any-only declaration or a consumer rewrite. |
| 681 SC2013, 12 packages | Every representative original import resolves own declaration files or TS source; npm static admission was OFF. | Configure/probe native package selection and then diagnose implementations. These are not missing-typing errors. |
| 77 SC2020 | Typed stdlib/Node APIs without scriptc lowering, including `process.hrtime.bigint`. | Compiler/runtime work. |
| memory CLI: 55 SC1016 + 1 SC1014 | Eager circular module initialization plus package re-export. | Compiler module semantics; optional consumer cycle refactor is a separate choice. |
| Herdr: 2 SC1090 | .mjs source reaches Error cause unsupported checks. | Add compiler semantics; source being JS is not the recorded refusal. Further lowering still untested. |
| memory-mcp registry: 1 SC2011 | Explicit `MemoryOperationDefinition<any, any>[]` erases heterogeneous operation correlations. | Consumer contract tightening candidate; typed Zod support is an independent compiler blocker. No proof annotation alone solves it. |
| rsp ChildProcess path | Unannotated `let child` followed by typed spawn assignments is boxed as unknown by compiler. | Compiler flow inference gap; explicit appropriate local type is a possible consumer simplification, not a missing npm declaration. |

## Packages actually named by dependency admission diagnostics

These 12 rows are causal samples from SC2013, not the complete transitive dependency list. Root audit owns that inventory.

| Package | Version | Declaration/source for exact representative importer | SC2013 occurrences |
|---|---|---|---:|
| `@reddb-io/toon` | 0.3.0 | `index.d.ts` | 63 |
| `@reddb-io/build-info` | 3.3.6 | `index.d.mts` | 33 |
| `@reddb-io/shared` | 3.3.6 | `args.ts` | 108 |
| `zod` | 3.25.76 | `index.d.cts` | 366 |
| `js-tiktoken` | 1.0.21 | `dist/index.d.ts` | 6 |
| `@reddb-io/sdk` | 1.23.1 | `index.d.ts` | 26 |
| `gray-matter` | 4.0.3 | `gray-matter.d.ts` | 4 |
| `@modelcontextprotocol/sdk` | 1.29.0 | `dist/esm/client/index.d.ts` | 32 |
| `@reddb-io/red-castle` | 0.11.0 | `src/engine/index.ts` | 36 |
| `@reddb-io/redskilled` | 0.1.0 | `src/client.ts` | 4 |
| `vscode-languageserver-protocol` | 3.18.2 | `lib/node/main.d.ts` | 2 |
| `fast-glob` | 3.3.3 | `out/index.d.ts` | 1 |

`require.resolve` failures for import-only export maps are preserved in JSON but do not mean the ESM importer cannot resolve. Original import resolution was additionally probed with TypeScript NodeNext/ESNext conditions.

## Missing installation context in Herdr

The original Herdr package currently has no `node_modules` directory. ESM `import.meta.resolve` from its exact original entry returns `ERR_MODULE_NOT_FOUND` for `@reddb-io/build-info` and `@reddb-io/toon`. Both are declared dependencies with typed surfaces available from other installed workspace consumers. This is an installation/link prerequisite, not absent typings. Its baseline two Error-cause diagnostics therefore do not prove the whole dependency graph is ready. Restore declared dependencies through the consumer workspace install procedure before a source build; do not run `materialize-entrypoint.mjs`, which can overwrite the original source entry with a downloaded bundle. That script documents the distinction itself.

TypeScript flow inspection also confirms `rsp` infers `child` as `ChildProcessByStdio<null, Readable, Readable>` at its four real uses, despite the unannotated evolving declaration. Thus those later `unknown` diagnostics should not be attributed to untyped Node dependencies.

## Minimum typing is not “no unknown”

`unknown` is a safe, intentional boundary requiring validation. There are 222 historical diagnostic messages containing that word, including 172 SC2009 shape errors on schema-bearing types. A Zod schema `ZodType<Input, ZodTypeDef, unknown>` is concretely typed. Treating all these as missing typings would misdiagnose compiler limitations. Likewise 9 of 11 messages containing `any` merely use it in generic explanation text. The other two are the ignored js-yaml declaration and the explicit operation registry erasure.

The gray-matter declaration exposes `data: { [key: string]: any }`, so validating frontmatter into a domain schema is a sensible consumer boundary. This audit did not demonstrate that this declaration causes a specific native refusal; its package currently stops at admission.

## Reproducible read-only probes

From `/tmp/scriptc-redcode-identity-20260913`:

```bash
TMPDIR=/tmp SCRIPTC_LIMIT_CPU=100% pnpm limit -- pnpm exec tsx /tmp/scriptc-dependency-compliance-20260913/redskills-typing-probe.mjs
node /tmp/scriptc-dependency-compliance-20260913/redskills-package-probe.mjs
TMPDIR=/tmp SCRIPTC_LIMIT_CPU=100% pnpm limit -- node /tmp/scriptc-dependency-compliance-20260913/redskills-flow-probe.mjs
```

The exact original `toon-version.ts` importer under consumer TypeScript options gives TS7016 and `yaml: any` if rooted alone. Adding its already-existing ambient declaration to program roots gives zero importer semantic diagnostics and `yaml: { load(input: string): unknown; }`. Scriptc `loadProgram` omits that declaration and reproduces SC0001. No source bytes were changed.

See `redskills-causes.json` for per-program counts, complete package metadata, exact original importer paths and evidence filenames.
