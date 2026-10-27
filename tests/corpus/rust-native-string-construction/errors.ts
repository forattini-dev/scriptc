// @rust-only
// @no-engine
// @ts-nocheck
export {};
function check(value:any):void{
 try{console.log("unit",String.fromCharCode(value));}catch(e){console.log("unit-error",String(e.name),String(e.message));}
 try{console.log("point",String.fromCodePoint(value));}catch(e){console.log("point-error",String(e.name),String(e.message));}
}
check(1n);check(Symbol("code"));check(-1);check(0x110000);check(3.5);
check(Number("bad"));check(1/0);check(-1/0);check(undefined);check("bad");
try{String.fromCodePoint(-1,Symbol("later"));}catch(e){console.log("range-before-symbol",String(e.name),String(e.message));}
try{String.fromCodePoint(1.5,2n);}catch(e){console.log("range-before-bigint",String(e.name),String(e.message));}
try{String.fromCodePoint(65,Symbol("later"));}catch(e){console.log("later-symbol",String(e.name),String(e.message));}
try{String.fromCodePoint(Symbol("first"),-1);}catch(e){console.log("symbol-first",String(e.name),String(e.message));}
