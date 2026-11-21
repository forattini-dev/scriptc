import { Base, Child } from "./methods.js";
const base: Base = new Base("base:");
const child: Base = new Child("value:");
let calls = 0;
console.log("base", base["~validate"]("x"));
console.log("child", child["~validate"]((calls++, "y")), calls);
console.log("wrapper", base.wrapper().validate("z"), child.wrapper().validate("w"));
