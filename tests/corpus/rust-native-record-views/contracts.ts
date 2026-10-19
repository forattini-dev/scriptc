import { narrow, copy } from "./bridge.js";
const values = ["one"]; const original: {value:string;extra?:string;values:string[]} = { value:"before", extra:"keep", values };
const view = narrow(original); view.value = "after"; const result = copy(view);
const a:any=original;const b:any=view;const c:any=result;
console.log("case",a===b,a!==c,original.value,c.values===values,Object.keys(result).join("|"));
