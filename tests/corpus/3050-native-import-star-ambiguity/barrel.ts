export * from "./left.ts";
// This valid runtime namespace deliberately suppresses the checker's TS2308:
// conflicting collision bindings are absent; shared/bump remain unambiguous.
// @ts-ignore
export * from "./right.ts";
export type { TypeMarker as marker } from "./types.ts";
export interface shape { value: string }
export * from "./runtime.ts";
