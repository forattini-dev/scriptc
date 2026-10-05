// @rust-only
// @no-engine
// @no-deprecation
import { lookup } from "node:dns";
import { promisify } from "node:util";
import { lookup as promiseLookup } from "node:dns/promises";

const resolve = promisify(lookup);

/** @param {string} hostname @param {boolean} preferIPv4 */
async function configured(hostname, preferIPv4) {
  const options = {};
  if (preferIPv4) options.family = 4;
  return await resolve(hostname, options);
}

console.log(JSON.stringify(await configured("localhost", true)));
console.log(JSON.stringify(await configured("::1", false)));
console.log(JSON.stringify(await configured("127.0.0.1", false)));
const options = {};
options.family = 4;
console.log(JSON.stringify(await promiseLookup("localhost", options)));

const pending = resolve("127.0.0.1");
pending.then(() => console.log("lookup settled"));
queueMicrotask(() => console.log("queued microtask"));
await pending;
console.log("lookup awaited");

function hostnameArgument() {
  console.log("hostname argument");
  return "::1";
}
function optionsArgument() {
  console.log("options argument");
  return { family: 4 };
}
console.log(JSON.stringify(await resolve(hostnameArgument(), optionsArgument())));

/** @returns {number} */
function failingArgument() {
  throw new Error("argument failed");
}
let argumentReturned = false;
try {
  const result = resolve("::1", failingArgument());
  argumentReturned = true;
  await result;
} catch (error) {
  console.log("argument error", argumentReturned, error.message);
}

const invalidOptions = {};
invalidOptions.family = false;
let invalidReturned = false;
try {
  const result = resolve("::1", invalidOptions);
  invalidReturned = true;
  await result;
} catch (error) {
  console.log("dynamic family", invalidReturned, error.name, error.code, error.message);
}

/** @param {string} hostname @param {number} family */
async function invalid(hostname, family) {
  let returned = false;
  try {
    const result = resolve(hostname, { family });
    returned = true;
    console.log("resolved", JSON.stringify(await result));
  } catch (error) {
    console.log("rejected", returned, error.name, error.code, error.message);
  }
}
await invalid("127.0.0.1", 5);
await invalid("", 6);
await invalid("bad\0host", 5);
console.error("promisified lookup finished");
