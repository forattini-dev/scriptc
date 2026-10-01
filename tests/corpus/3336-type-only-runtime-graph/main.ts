// @rust-only
// @no-engine
import type { Shape } from "./library.ts";
import type * as Library from "./library.ts";
import { local, type Shape as ReexportShape } from "./barrel.ts";
export interface EntryShape { count: number }
const direct: Shape = { label: "direct" };
const namespace: Library.Shape = { label: "namespace" };
const reexport: ReexportShape = { label: "reexport" };
console.log(direct.label, namespace.label, reexport.label, local);
