// @no-engine
const state = {};
function put(key, value) { state[key] = value; }
put("name", "first");
put(2, "two");
put(-0, "zero");
put(true, "yes");
put(false, "no");
put(null, "nil");
put(undefined, "missing");
put(NaN, "nan");
put(Infinity, "infinity");
put("name", "last");
console.log(JSON.stringify(state));
