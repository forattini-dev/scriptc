// @rust-only
// @no-engine
console.log((await new Response(" \uFEFFHi 😀\n").text()).trim().toLowerCase());
console.log((await new Response("  A  ").text()).trimStart());
console.log((await new Response("  B  ").text()).trimEnd());
console.log((await new Response("😀").text()).length);
let calls = 0;
function receiver(): Promise<string> { calls++; console.log("receiver", calls); return Promise.resolve("abcdef"); }
async function index(label: string, n: number): Promise<number> { console.log(label); return n; }
console.log((await receiver()).slice(await index("start", 1), await index("end", 4)), calls);
try {
  console.log((await receiver()).substring(await index("protected start", 2), await index("protected end", 5)));
  console.log((await new Response(" YES ").text()).trim().toLowerCase());
} finally { console.log("finally"); }
const rejected: Promise<string> = Promise.reject(new Error("no text"));
try {
  (await rejected).trim();
} catch (error) { console.log("caught", (error as Error).message); }
const consumed = new Response(" used ");
await consumed.text();
try { (await consumed.text()).trim(); }
catch (error) { console.log("consumed", (error as Error).name); }
async function result(): Promise<string> {
  try { return (await new Response(" result ").text()).trim(); }
  finally { console.log("return finally"); }
}
console.log(await result());
export {};
