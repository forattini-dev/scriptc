# Public npm @types candidates

Read-only npm registry metadata checked on 2026-09-13T17:01:50.782240+00:00. No packages installed or executed. Two small tarballs were subsequently parsed in memory to verify exact-subpath declarations; their SHA512 values matched the registry. No filesystem extraction occurred. All nine latest endpoints returned HTTP 200 and advertised declaration files; none were marked deprecated or described as stubs. These are available candidates, not version-validated fixes.

| Candidate | Latest | Published | Notes |
|---|---|---|---|
| [@types/npmcli__config](https://www.npmjs.com/package/@types/npmcli__config) | 6.0.4 | 2026-06-24T13:00:28.183Z | Installed runtime 10.8.1; declaration major 6 requires API audit. |
| [@types/npmcli__map-workspaces](https://www.npmjs.com/package/@types/npmcli__map-workspaces) | 3.0.4 | 2023-11-07T12:07:48.067Z | Installed runtime 5.0.3; declaration major 3 requires API audit. |
| [@types/parcel__watcher](https://www.npmjs.com/package/@types/parcel__watcher) | 2.0.5 | 2023-11-07T12:32:48.235Z | Native addon support remains separate from types. |
| [@types/ini](https://www.npmjs.com/package/@types/ini) | 4.1.1 | 2024-06-09T05:35:21.592Z | Installed runtime 6.0.0; declaration major 4 requires API audit. |
| [@types/nopt](https://www.npmjs.com/package/@types/nopt) | 3.0.32 | 2023-11-07T12:03:37.943Z | Installed runtime 9.0.0; declaration major 3 requires API audit. |
| [@types/proc-log](https://www.npmjs.com/package/@types/proc-log) | 3.0.4 | 2023-11-07T13:23:52.877Z | Installed runtime 6.1.0; declaration major 3 requires API audit. |
| [@types/is-glob](https://www.npmjs.com/package/@types/is-glob) | 4.0.4 | 2023-11-07T08:03:01.124Z | Runtime 4.0.3; inspect parameters/options before adopting. |
| [@types/is-extglob](https://www.npmjs.com/package/@types/is-extglob) | 2.1.0 | 2023-12-04T20:35:44.273Z | Runtime 2.1.1; inspect accepted input contract before adopting. |
| [@types/js-yaml](https://www.npmjs.com/package/@types/js-yaml) | 4.0.9 | 2023-11-07T20:20:13.264Z | Red-skills already has a local minimum declaration; ambient-root omission remains compiler issue. |

All expose `types: index.d.ts`. `@types/js-yaml` additionally provides conditional type exports (`index.d.mts` for import, `index.d.ts` default). JSON preserves exact registry URLs, status, description, deprecation value, dependencies, exports, publication/lookup times and tarball integrity metadata.

Installing these is not an automatic native-build fix: scriptc auto-admission currently rejects third-party `@types` as the package declaration source, and native body lowering still needs correct JS inference and runtime semantics. New declarations must match the actual installed versions and consumers must validate dynamic inputs; avoid any-only shims.

## Exact subpath follow-up

| Consumer import | Candidate inspected | Result |
|---|---|---|
| `@npmcli/config/lib/definitions/index.js` | `@types/npmcli__config@6.0.4` | Includes `lib/definitions/index.d.ts` (365 bytes), exporting defaults, definitions, flatten, nerfDarts, proxyEnv and shorthands. A genuine subpath candidate; runtime 10.8.1 API not validated and several fields remain any. |
| `@parcel/watcher/wrapper` | `@types/parcel__watcher@2.0.5` | Contains only root `index.d.ts`; no wrapper declaration, module augmentation or `createWrapper` symbol. Root typings do not cover this private import. |

The watcher consumer imports the extensionless subpath at `packages/core/src/filesystem/watcher.ts:4`; it resolves to `wrapper.js`, whose API is `createWrapper(binding)`, unlike the public root watcher API. For a declaration-based fix, this import needs its own correct version-specific private-subpath declaration/typed integration; improving compiler inference is another route. Its native addon dependency remains a separate compiler/runtime issue.

See `registry-subpath-probe.json` for full declaration text and file inventories. The config candidate physically contains the matching declaration path, but no package install/resolver/API compatibility test was performed.
