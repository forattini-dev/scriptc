// @npm-static: auto
// @no-engine
import { encode, decode, alias, classify, hoisted, effectful, pinned } from "esm-codec";
import { parse, Child } from "cjs-parser";
console.log(encode("native"), decode("NATIVE"), alias("Shared"), alias(7));
console.log(parse("one"), parse("two"));
console.log(new Child().read());
console.log(classify("branch"), classify(8), classify({ name: "typed" }));
console.log(hoisted(4), effectful("read"), effectful(4), pinned("Pinned"));
