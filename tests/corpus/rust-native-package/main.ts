// @rust-only
// @no-engine
// @npm-static: auto
import { triple as fromPackage } from "native-export";
import { triple } from "native-export";
import { local } from "./local.ts";
console.log("package", fromPackage(local(7)), triple(2));
