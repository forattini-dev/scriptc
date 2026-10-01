// @rust-only
// @no-engine
// Builtin records retain their construction order across reflection and copies.
const cpu = process.cpuUsage();
console.log("cpu", Object.keys(cpu).join(","));
console.log("cpu diff", Object.keys(process.cpuUsage(cpu)).join(","));
const thread = process.threadCpuUsage();
console.log("thread", Object.keys(thread).join(","));
console.log("thread diff", Object.keys(process.threadCpuUsage(thread)).join(","));
const view: { system: number; user: number } = cpu;
console.log("view", Object.keys(view).join(","));
console.log("cpu copy", Object.keys({ ...cpu, marker: 1 }).join(","));
const usage = process.resourceUsage();
console.log("resource", Object.keys(usage).join(","));
console.log("resource copy", Object.keys({ ...usage, marker: 1 }).join(","));
console.log("resource entries", Object.entries(usage).map(entry => entry[0]).join(","));
