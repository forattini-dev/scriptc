// @rust-only
// @no-engine
// @no-deprecation
import { lookup } from "node:dns/promises";

async function emptyHostname() {
  let returned = false;
  try {
    const pending = lookup("", { family: 6 });
    returned = true;
    console.log("empty", JSON.stringify(await pending));
  } catch (error) {
    console.log("empty rejected", returned, error.name, error.code, error.message);
  }
}

async function invalidFamily() {
  let returned = false;
  try {
    const pending = lookup("127.0.0.1", 5);
    returned = true;
    await pending;
  } catch (error) {
    console.log("family", returned, error.name, error.code, error.message);
  }
  try {
    await lookup("127.0.0.1", { family: 5 });
  } catch (error) {
    console.log("property", error.name, error.code, error.message);
  }
  try {
    await lookup("bad\0host", { family: 5 });
  } catch (error) {
    console.log("validation order", error.name, error.code, error.message);
  }
}

await emptyHostname();
await invalidFamily();
console.error("dns error paths finished");
