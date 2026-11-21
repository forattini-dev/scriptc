// @rust-only
// @no-engine
import proc, { argv as importedArgs } from "node:process";
const args = process.argv;
console.log("shape", args.length >= 2, args === process.argv);
console.log("imports", importedArgs === args, proc.argv === args);
console.log("missing alias", args[1000] === undefined, importedArgs[1000] !== "value", args[1000] == null);
const words = ["value"];
const nums = [1];
console.log("missing arrays", words[3] === undefined, nums[3] !== 1, words[0] === "value", nums[0] === 1);
console.log("tail", args.slice(2).join("|"));
args.push("added");
console.log("shared", process.argv[process.argv.length - 1] === "added");
