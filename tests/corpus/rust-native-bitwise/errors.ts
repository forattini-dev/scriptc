// @rust-only
// @no-engine
// @ts-nocheck
export {};
function check(a:any,b:any):void{
 try{console.log("and",String(a&b));}catch(e){console.log("and-error",String(e.name),String(e.message));}
 try{console.log("shift",String(a>>>b));}catch(e){console.log("shift-error",String(e.name),String(e.message));}
 try{console.log("not",String(~a));}catch(e){console.log("not-error",String(e.name),String(e.message));}
}
check(1n,1n);check(1n,1);check(1,1n);check(Symbol("a"),1n);check(1n,Symbol("b"));
console.log("static-bigint",String(5n&3n),String(5n|2n),String(5n^3n),String(8n<<-1n),String(-9n>>1n),String(~5n));
try{console.log("unsigned-bigint",String(1n>>>1n));}catch(e){console.log("unsigned-error",String(e.name),String(e.message));}
