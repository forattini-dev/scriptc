# Exact @types subpaths

- `@types/npmcli__config@6.0.4`: contains `index.d.ts` and `lib/definitions/index.d.ts`. The latter exports the definitions object and is a concrete candidate for `@npmcli/config/lib/definitions/index.js`; compatibility with runtime 10.8.1 remains untested.
- `@types/parcel__watcher@2.0.5`: contains only `index.d.ts`. No declaration for consumer import `@parcel/watcher/wrapper`, no matching ambient module and no `createWrapper` export. Installing this root package alone cannot type the imported wrapper factory.

Tarballs (4,725 and 1,899 compressed bytes) were downloaded and parsed only in memory; SHA512 matched npm registry metadata. No filesystem extraction, execution, package install or source change. Full declaration/file inventory is in `registry-subpath-probe.json`; consolidated conclusions are in `registry-types-candidates.md`.
