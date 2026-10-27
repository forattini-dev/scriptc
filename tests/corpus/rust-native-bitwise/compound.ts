// @rust-only
// @no-engine
// @ts-nocheck
export {};
let n=5;
function mutate():number{n=128;return 2;}
console.log("old-before-rhs",n|=mutate(),n);
console.log("ops",n&=3,n^=7,n<<=32,n>>=-1,n>>>=0);
let b=15n;
console.log("big",String(b&=7n),String(b|=8n),String(b^=3n),String(b<<=-2n),String(b>>=1n));
console.log("arithmetic",String(b+=2n),String(b*=3n));
try{b>>>=1n;}catch(e){console.log("typed-no-write",String(e.message),String(b));}
let erased:any="15";
console.log("erased",String(erased&=7),typeof erased);
erased=8n;console.log("erased-big",String(erased>>=1n),typeof erased);
try{erased>>>=1n;}catch(e){console.log("no-write",String(e.message),String(erased));}
try{erased|=1;}catch(e){console.log("mixed-no-write",String(e.message),String(erased));}
let uncertain:unknown=1;uncertain+=2;console.log("unknown",String(uncertain));
let tag:any=1;tag+="x";console.log("erased-string",String(tag));
let captured:any=3n;
function update():any{return captured|=8n;}
console.log("capture",String(update()),String(captured));
let bad:any=Symbol("left");
try{bad^=mutate();}catch(e){console.log("throw-no-write",String(e.message),typeof bad,n);}
