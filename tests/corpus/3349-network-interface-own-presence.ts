// @rust-only
// @no-engine
// Native producer records distinguish an absent field from present undefined.
import { networkInterfaces } from "node:os";
const interfaces = networkInterfaces();
const names = Object.keys(interfaces).sort();
for (const name of names) {
  const rows = interfaces[name];
  if (!rows) continue;
  for (const row of rows) {
    if (row.family === "IPv4") {
      console.log("IPv4", Object.keys(row).join(","), row.scopeid === undefined);
    } else {
      console.log("IPv6", Object.keys(row).join(","), row.scopeid >= 0);
    }
  }
}
const explicit: { scopeid?: number } = { scopeid: undefined };
console.log("explicit", Object.keys(explicit).join(","), explicit.scopeid === undefined);
