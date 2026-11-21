// @rust-only
// @no-engine
// @npm-static: auto
import { triple as fromPackage } from "native-export";
import { hasNamespace, triple } from "native-export";
import * as nativeNamespace from "native-export";
import { plusOne, triple as reexportedTriple } from "direct-runtime-export";
import { local } from "./local.ts";
console.log("package", fromPackage(local(7)), triple(2), plusOne(8), reexportedTriple(4));
console.log("namespace", hasNamespace(nativeNamespace));
