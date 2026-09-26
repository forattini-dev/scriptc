// A module-namespace promise stored at file scope retains its native
// Promise<moduleNs> ABI even when @types/node exposes the builtin as an
// anonymous object type.
import * as declaredPath from "node:path";

const pathPromise = import("node:path");

async function main(): Promise<void> {
  const path = await pathPromise;
  console.log(declaredPath === path);
  console.log(path.basename("one/two.txt"));
  console.log(await pathPromise.then((ns) => ns.dirname("one/two.txt")));
}

main();
