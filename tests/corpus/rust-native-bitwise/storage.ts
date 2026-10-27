// @rust-only
// @no-engine
// @ts-nocheck
export {};
const a:any=9n;const b:any=2n;
const binary=a|b;const inverted=~a;
const read=():any=>binary;const readNot=():any=>inverted;
console.log("module",typeof read(),String(read()),typeof readNot(),String(readNot()));
console.log("before",typeof hoisted,String(hoisted),typeof unary,String(unary));
var hoisted=a^b;var unary=~a;
console.log("hoisted",typeof hoisted,String(hoisted),typeof unary,String(unary));
function local(a:any,b:any):void{
 console.log("local-before",typeof value,String(value));
 var value=a&b;
 const read=():any=>value;
 console.log("local",typeof read(),String(read()));
 value=a|b;
 console.log("local-updated",typeof read(),String(read()));
 let slot:number|undefined=undefined;console.log("optional",slot|=2,slot);
}
local(9n,3n);local(9,3);
