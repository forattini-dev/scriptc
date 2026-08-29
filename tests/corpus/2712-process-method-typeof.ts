// Capability guards used by packages that support Windows Node as well.
const uid = typeof process.getuid === "function" ? process.getuid() : -1;
const gid = typeof process.getgid === "function" ? process.getgid() : -1;

console.log("uid", Number.isInteger(uid), uid >= 0);
console.log("gid", Number.isInteger(gid), gid >= 0);
