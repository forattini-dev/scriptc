// @rust-only
// @no-engine
// @ts-nocheck
export {};
function add(a:any,b:any):any{return a+b;}
const values:any[]=[2,"2",true,null,undefined,5n];
for(const a of values){
 for(const b of values){
  try{const result=add(a,b);console.log("add",typeof a,typeof b,typeof result,String(result));}
  catch(error){console.log("add-error",typeof a,typeof b,String(error.message));}
 }
}
let trace="";
function rhs():any{trace+="rhs;";return "text";}
try{add(Symbol("left"),rhs());}catch(error){console.log("symbol-string",String(error.message),trace);}
try{add(Symbol("left"),3);}catch(error){console.log("symbol-number",String(error.message));}
const first:any=1n;
const sum=first+first;
console.log("module-add",typeof sum,String(sum));
