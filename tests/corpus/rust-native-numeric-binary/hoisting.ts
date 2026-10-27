// @rust-only
// @no-engine
// @ts-nocheck
export {};
console.log("module-before",typeof duration,String(duration));
var duration=5*1e3;
console.log("module-after",duration);
const left:any=9n;const right:any=2n;
console.log("big-before",typeof difference,String(difference));
var difference=left-right;
console.log("big-after",typeof difference,String(difference));
function local(a:any,b:any):void{
 console.log("local-before",typeof result,String(result));
 var result=a*b;
 const read=():any=>result;
 console.log("local-init",typeof read(),String(read()));
 result=a-b;
 console.log("local-updated",typeof read(),String(read()));
}
local(9n,2n);local(9,2);
let calls=0;
function produce(value:number|string):number|string{calls+=1;return value;}
const widened:number|string|undefined=produce("text");
console.log("widening",typeof widened,String(widened),calls);
