import process from "node:process";

let calls = 0;
const cancel = () => {
  calls++;
};

process.on("SIGINT", cancel);
process.once("SIGTERM", cancel);
process.off("SIGINT", cancel);
process.removeListener("SIGTERM", cancel);
console.log(String(calls));
