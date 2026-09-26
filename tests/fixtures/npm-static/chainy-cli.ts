// Chained getter/setter calls typed by the package's own .d.ts overloads.
// --npm-static projects the safe overload groups onto the matching runtime
// JavaScript class, preserving the authored call surface while compiling
// and validating the actual implementation body.
import { Chainy } from "chainy";

const c = new Chainy();
c.name("emulate").tag("cli");
console.log(c.render());
console.log(c.name());
console.log(c.readOwnName());
console.log(c.findOwnName(["other", "emulate"]));
console.log(c.findOwnName([""]));
console.log(c.ancestorNames().join(","));
