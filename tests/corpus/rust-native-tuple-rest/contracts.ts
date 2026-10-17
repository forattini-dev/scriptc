// @rust-only
// @no-engine
import { createTokenAuth, pair, empty } from "./library.js";
const first = createTokenAuth("first");
const second = createTokenAuth("second");
first().then(result => { console.log("first", result.token); });
second().then(result => { console.log("second", result.token); });
console.log("hook", first.hook((value: number) => value + 1, 7));
console.log("overload", second.hook((value: string) => `${value}!`, "value", 3));
const factory = createTokenAuth;
factory("alias")().then(result => { console.log("alias", result.token); });
console.log("tuple slots", pair(4), pair(5, "text"), empty());
