// @rust-only
// @no-engine
import { createCounter, identity, sameObject, inspect, replace, invalidate } from "./source.js";
interface Counter { push(value: number): number; end(): number }
const counter: Counter = createCounter();
const alias: Counter = identity(counter);
console.log(counter.push(2), alias.push(3), counter.end());
console.log(counter === alias, sameObject(counter, alias), counter.push === counter.push);
const original = counter.push;
replace(alias);
console.log(counter.push(4), alias.push(5), original(1), counter.end());
console.log(counter.push === alias.push, counter.push === original, sameObject(counter.push, alias.push));
counter.push = (value: number): number => value + 100;
console.log(inspect(alias), counter.push === alias.push);
invalidate(alias);
try { counter.push(1); } catch (error) { console.log(error instanceof TypeError); }
console.log(counter.end());
