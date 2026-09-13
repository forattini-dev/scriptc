# Six Redcode transitive JS dependencies: typing probe

All six installed versions lack declaration files and JSDoc typing tags, and no corresponding `@types` resolves from the exact importer or exists in this checkout's Bun store. This is a real declaration-surface gap, but it does **not** establish that the packages are impossible to compile or explain the current Redcode failure.

| Exact package/version | Original requiring module | Inferred JavaScript surface | Interpretation |
|---|---|---|---|
| `is-glob@4.0.3` | `@parcel/watcher/wrapper.js:3` | `(str: any, options: any): boolean` | Return/guard behavior already inferable; compiler inference candidate. |
| `is-extglob@2.1.1` | `is-glob/index.js:8` | `(str: any): boolean` | Explicit string guard; small predicate, not inherently opaque. |
| `ini@6.0.0` | `@npmcli/config/lib/index.js:3` | parse/decode returns `any`; encode/stringify returns `string` | Correct structured/validated parser boundary would improve typing; parser body support remains separate. |
| `nopt@9.0.0` | `@npmcli/config/lib/index.js:4` | Callable; input maps `any`; argv shape partially inferred | Dynamic option/result keys and singleton callback properties need explicit modeling or compiler support. |
| `proc-log@6.1.0` | `@npmcli/config/lib/index.js:5` | Nested event APIs, variadic `any[]`, callback/Promise returns | Needs event/payload contracts and process event semantics, not merely a TS extension. |
| `@npmcli/map-workspaces@5.0.3` | `@npmcli/config/lib/index.js:738` | `(opts?: {}): Promise<Map<any, any>>`; `.virtual` returns Map | Input/options and mapping contract could be typed; filesystem/glob/Map implementation remains independent. |

The probe uses TypeScript 5.9.3 over the six original JS runtime roots (`allowJs`, no `checkJs`, depth four), and queries inferred exports. It is **not a strict project typecheck or a native build**. Full types, package paths, runtime SHA256, resolver outcomes and source scans are retained in `transitive-typing-probe.json`. Local ambient candidates in the root inventory are empty for these exact edges.

The latest complete CLI attempt (`5e0830c2`, 3,090 diagnostics) did not select any of these six packages in its explicit `npmStatic` set, and emitted no diagnostics located inside them or naming them as a quoted package specifier. Treat these as additional dependencies encountered by runtime graph inspection, not a demonstrated explanation of that diagnostic count.

Dependency maintainers or consumer integration can supply accurate versioned declarations or validated boundary adapters. Scriptc must still infer/admit/lower their real JavaScript bodies. Current automatic admission rejects packages without their own declarations (and rejects external `@types` surfaces); native static loading hides declaration twins while analyzing implementations. Therefore installing `@types` alone cannot be presented as the fix.

For simple predicates, strengthen compiler inference and add differential native coverage. For config parsers/event APIs/workspace maps, specify real input/output contracts and independently test required runtime semantics. Do not replace unknown data with unjustified assertions or fake any-only declarations.

Reproduce without source modifications/installations:

```bash
cd /tmp/scriptc-redcode-identity-20260913
TMPDIR=/tmp SCRIPTC_LIMIT_CPU=100% pnpm limit -- node /tmp/scriptc-dependency-compliance-20260913/transitive-typing-probe.mjs
```
