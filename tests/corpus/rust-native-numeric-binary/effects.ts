// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace="";
function left(value:any):any{trace+="left;";return value;}
function right(value:any):any{trace+="right;";return value;}
function fail():any{trace+="throw;";throw new Error("rhs");}
function sub(a:any,b:any):any{return a-b;}
try{left(Symbol("left"))/right(2n);}catch(error){console.log("conversion-after-rhs",String(error.message),trace);}
trace="";
try{left(Symbol("left"))/fail();}catch(error){console.log("rhs-abrupt",String(error.message),trace);}
trace="";
try{left(3n)*right(Symbol("right"));}catch(error){console.log("right-symbol-before-mixing",String(error.message),trace);}
trace="";
console.log("both-once",String(sub(left("7"),right(3))),trace);
const cell:any={value:12};
function mutate():any{cell.value=20;return 2;}
console.log("snapshot-before-rhs",String(cell.value/mutate()),String(cell.value));
trace="";
console.log("units",String((left(true)?undefined:undefined)/right(2)),trace);
