// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace="";
function left(a:any):any{trace+="left;";return a;}
function right(a:any):any{trace+="right;";return a;}
function fail():any{trace+="throw;";throw new Error("rhs");}
try{left(Symbol("a"))|right(1n);}catch(e){console.log("both-before-conversion",String(e.message),trace);}
trace="";
try{left(Symbol("a"))<<fail();}catch(e){console.log("rhs-abrupt",String(e.message),trace);}
trace="";
try{left(1n)>>>right(Symbol("b"));}catch(e){console.log("convert-before-domain",String(e.message),trace);}
trace="";
console.log("once",String(left("7")&right(3)),trace);
trace="";
try{~left(Symbol("a"));}catch(e){console.log("unary-once",String(e.message),trace);}
trace="";
function unit():void{trace+="unit;";}
console.log("void-operands",unit()|right(2),~unit(),trace);
let erased:any=7;console.log("void-compound",erased&=unit(),String(erased),trace);
