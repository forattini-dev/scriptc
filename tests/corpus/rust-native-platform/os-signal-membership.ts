import { constants as osConstants } from "node:os";

console.log("SIGINT" in osConstants.signals);
console.log("SIGUSR1" in osConstants.signals);
console.log("NO_SIGNAL" in osConstants.signals);
