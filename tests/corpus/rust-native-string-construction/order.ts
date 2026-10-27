// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace="";
function first(value:any):any{trace+="first;";return value;}
function second(value:any):any{trace+="second;";return value;}
function fail():any{trace+="throw;";throw new Error("rhs");}
try{String.fromCharCode(first(Symbol("a")),fail());}catch(e){console.log("rhs-before-unit-conversion",String(e.message),trace);}
trace="";
try{String.fromCodePoint(first(-1),fail());}catch(e){console.log("rhs-before-range-check",String(e.message),trace);}
trace="";
try{String.fromCodePoint(first(-1),second(Symbol("b")));}catch(e){console.log("all-values-first",String(e.name),String(e.message),trace);}
trace="";
console.log("once",String.fromCharCode(first("65"),second(66)),trace);
trace="";
console.log("points-once",String.fromCodePoint(first("65"),second(0x1f600)),trace);
trace="";
function unit():void{trace+="unit;";}
const value=String.fromCharCode(unit(),second(65));
console.log("void-unit",value.length,value.charCodeAt(0),value.charCodeAt(1),trace);
trace="";
try{String.fromCodePoint(unit(),second(65));}catch(e){console.log("void-point",String(e.message),trace);}
let code:any=65;
function mutate():any{code=90;return 66;}
console.log("snapshot",String.fromCharCode(code,mutate()),String(code));
