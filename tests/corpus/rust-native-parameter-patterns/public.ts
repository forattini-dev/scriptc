// @rust-only
// @no-engine
// @npm-static: auto
import { named, closure } from "native-parameter-patterns";
console.log("public", named(), named({name: "N", extra: 2}), named(undefined, "ignored"));
console.log("closure", closure(), closure({value: 3, extra: 4}));
const alias = named;
console.log("alias", alias({name: "A"}));
