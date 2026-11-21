let backing = 1;
const target = {};
Object.defineProperty(target, "x", { get() { return backing; }, set(value) { backing = value; }, enumerable: true, configurable: true });
const alias = target;
const result = Object.freeze(target);
console.log(result === target, Object.isFrozen(target));
try { alias.x = 7; console.log("value", alias.x); } catch (error) { console.log(error instanceof TypeError ? "TypeError" : "other"); }
try { alias.extra = 7; console.log("added"); } catch (error) { console.log(error instanceof TypeError ? "TypeError" : "other"); }
const descriptor = Object.getOwnPropertyDescriptor(alias, "x");
console.log(descriptor ? String(descriptor.writable) + ":" + descriptor.configurable + ":" + typeof descriptor.set : "absent");
