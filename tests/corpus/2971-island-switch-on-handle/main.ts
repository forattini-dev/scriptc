// @dynamic
// @rust-only
// @island-module: ./args.ts
// A static switch whose scrutinee is a field of a record an island
// module answered: the handle exits to its declared static type once,
// then the switch runs as any static one (union with null, string
// literals, numbers).
import { parse } from "./args.ts";

function run(argv: string[]): string {
  const inv = parse(argv);
  let out = "";
  switch (inv.command) {
    case "platform": {
      const tag = "P";
      out += tag;
      return out + "!";
    }
    case "plan":
      out += "L";
      break;
    case null:
      out += "-";
      break;
    default:
      out += "?";
  }
  switch (inv.action) {
    case "theme":
      out += "t";
      break;
    case "wallpaper":
      out += "w";
      break;
    case "doctor":
      out += "d";
      break;
  }
  switch (inv.count) {
    case 0:
      out += "0";
      break;
    case 1:
      out += "1";
      break;
    default:
      out += "+";
  }
  return out;
}

console.log(run([]));
console.log(run(["platform"]));
console.log(run(["plan", "--x"]));
console.log(run(["other"]));
