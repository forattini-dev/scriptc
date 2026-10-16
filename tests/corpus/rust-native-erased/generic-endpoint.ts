import { endpoint } from "./endpoint.js";
console.log("endpoint", endpoint("GET /"), endpoint(7), endpoint.parse("parsed"));
console.log("metadata", endpoint.DEFAULTS.method);
const alias = endpoint;
console.log("alias", alias === endpoint, alias("same"));
const options = { method: "POST" };
const next = endpoint.defaults(options);
console.log("next", next("POST /"), next.DEFAULTS.method, next !== endpoint);
console.log("merge", next.merge("merged"));
options.method = "PATCH";
console.log("shared", next.DEFAULTS.method);

const makeDefaults = endpoint.defaults;
const extracted = makeDefaults({ method: "DELETE" });
console.log("defaults-alias", extracted.parse("ok"), extracted.DEFAULTS.method);

alias.DEFAULTS = { method: "PUT" };
console.log("updated-defaults", endpoint.DEFAULTS.method, next.DEFAULTS.method);
function replacement<T>(value: T): T { console.log("replacement-called"); return value; }
alias.parse = replacement;
console.log("updated-parse", endpoint.parse("changed"), next.parse("original"));
