// dns.lookup resolves at call time but schedules its callback for a later
// event-loop turn. Keep the assertion independent of the host's chosen
// localhost address while pinning the public callback contract.
import { lookup } from "node:dns";

console.log("before");
lookup("localhost", { family: 4 }, (error, address, family) => {
  console.log("callback:", error === null, typeof address, address.includes("."), family);
});
console.log("after");
