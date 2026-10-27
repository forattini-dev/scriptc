// @rust-only
// @no-engine
// @ts-nocheck
export {};
function sub(a:any,b:any):any{return a-b;}
function mul(a:any,b:any):any{return a*b;}
function div(a:any,b:any):any{return a/b;}
function rem(a:any,b:any):any{return a%b;}
function pow(a:any,b:any):any{return a**b;}
function report(name:string,run:()=>any):void{
 try{console.log("error",name,"returned",String(run()));}
 catch(error){console.log("error",name,error instanceof TypeError,error instanceof RangeError,String(error.message));}
}
report("mixed-left",()=>sub(3n,2));
report("mixed-right",()=>mul("3",2n));
report("mixed-unit",()=>div(undefined,2n));
report("mixed-bool",()=>rem(3n,true));
report("mixed-power",()=>pow(2n,"2"));
report("symbol-left",()=>sub(Symbol("left"),2n));
report("symbol-right",()=>div(2n,Symbol("right")));
report("zero-div",()=>div(2n,0n));
report("zero-rem",()=>rem(2n,0n));
report("negative-power",()=>pow(2n,-1n));
