// @rust-only
// @no-engine
function event(value: string): void { console.log("order", value); }
const base = Promise.resolve(1);
const child = base.then((value) => { event("first"); return Promise.resolve(value + 1); });
base.then(() => { event("sibling"); });
child.then((value) => { console.log("adopted", value); });
const passthrough: any = base;
passthrough.then().then((value: number) => { console.log("pass", value); });
passthrough.then(7).then((value: number) => { console.log("ignored", value); });
Promise.resolve(0).then(() => { event("a"); }).then(() => { event("b"); }).then(() => { event("c"); });
event("sync");
