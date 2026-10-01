/// <reference path="./ambient.d.ts" />
import "missing-type-graph-runtime";
import type { EntryShape } from "./main.ts";
export interface Shape { label: string }
export const erased: EntryShape = { count: 7 };
console.log("this module must never execute");
