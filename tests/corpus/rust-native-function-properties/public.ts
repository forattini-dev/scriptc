// @rust-only
// @no-engine
// @npm-static: auto
import { auth, inspect, update } from "native-function-properties";
const alias = auth;
console.log("public", alias.VERSION === "first", inspect() === "first", alias(4));
update("second");
console.log("updated", auth.VERSION === "second", alias.VERSION === "second", alias === auth);
alias.VERSION = "third";
console.log("shared", inspect() === "third", Object.keys(auth).join("|"), Object.hasOwn(auth, "VERSION"));
const erased: any = auth;
console.log("delete", delete erased.VERSION, alias.VERSION === undefined, Object.hasOwn(auth, "VERSION"), alias(1));
