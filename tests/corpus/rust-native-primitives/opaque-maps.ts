// @rust-only
// @no-engine
import { echo, relay } from "./opaque-library.mjs";
function pass(value: Object): Object { return value; }
function object(value: object): object { return value; }
const map = new Map<string, number>();
map.set("value", 42);
console.log("maps", pass(map) === map, object(map) === map, echo(map) === map, relay(map) === map, Array.isArray(echo(map)));
