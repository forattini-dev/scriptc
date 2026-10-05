// @rust-only
// @no-engine
import dns from "node:dns/promises";
import { lookup } from "dns/promises";

const first = await dns.lookup("127.0.0.1", { family: 4 });
console.log(first.address, first.family);
const second = await lookup("::1", { family: 6 });
console.log(second.address, second.family);
console.log(JSON.stringify(await lookup("127.0.0.1")));
console.log(JSON.stringify(await lookup("::1", 4)));
console.log(JSON.stringify(await lookup("localhost", { family: 4 })));
console.log(JSON.stringify(await lookup("localhost")));
console.log(JSON.stringify(await lookup("2001:0db8:0:0:0:0:0:1", {})));
async function configured(hostname: string, preferIPv4: boolean) {
  const options: { family?: number } = {};
  if (preferIPv4) options.family = 4;
  return await lookup(hostname, options);
}
console.log(JSON.stringify(await configured("localhost", true)));
console.log(JSON.stringify(await configured("::1", false)));
const optional: { family?: number } = { family: undefined };
console.log(JSON.stringify(await lookup("127.0.0.1", optional)));
console.error("dns lookup finished");
// A user interface with the builtin's name retains its own representation.
interface LookupAddress { address: number; family: string; }
const local: LookupAddress = { address: 9, family: "user" };
console.log(local.address + 1, local.family);
