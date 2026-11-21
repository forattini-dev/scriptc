// @rust-only
// @no-engine
import { userInfo } from "node:os";

const first = userInfo();
const second = userInfo();
console.log(typeof first.uid === "number", typeof first.gid === "number");
console.log(first.username.length > 0, first.homedir.length > 0);
console.log(first.shell === null || typeof first.shell === "string");
console.log(first.username === second.username, Object.keys(first).join(","));
