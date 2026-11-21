// @rust-only
// @no-engine
import { stdin } from "node:process";

const listener = () => console.log("unexpected");
stdin.on("data", listener);
stdin.removeListener("data", listener);
console.log(stdin.isPaused(), stdin.isRaw === undefined);
