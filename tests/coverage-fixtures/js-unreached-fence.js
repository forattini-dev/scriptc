// A JavaScript program whose ENTRY PATH is fully static while a function
// nothing calls is not: the build carries no fence (unreached bodies never
// lower), and the report counts the deferred fence the unused corner WOULD
// add in its own dimmed group, apart from the reached "deferred to runtime"
// sites.
import { extname } from "node:path";

function used(n) {
  return n + 1;
}

// Never called: the escaping builtin alias has no static function value.
function unusedCorner() {
  const ext = extname;
  console.log(ext);
}

console.log(used(41));
