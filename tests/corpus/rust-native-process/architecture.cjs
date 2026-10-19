// @rust-only
// @no-engine
var proc = require("node:process");
console.log("arch", proc.arch, proc["arch"]);
console.log("platform", proc.platform, proc["platform"]);
/** @param {{arch: string, platform: string}} process */
function local(process) { return process.arch + "/" + process.platform; }
console.log("shadow", local({ arch: "local-cpu", platform: "local-os" }));
