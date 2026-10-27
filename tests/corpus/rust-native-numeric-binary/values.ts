// @rust-only
// @no-engine
// @ts-nocheck
export {};
function sub(a:any,b:any):any{return a-b;}
function mul(a:any,b:any):any{return a*b;}
function div(a:any,b:any):any{return a/b;}
function rem(a:any,b:any):any{return a%b;}
function pow(a:any,b:any):any{return a**b;}
function scale(a:any):number{return (a/255)*100;}
const values:any[]=[8," 6 ",true,false,null,undefined,Number("bad"),(1/0),-0];
for(const value of values){
 console.log("primitive",String(value),String(sub(value,"2")),String(mul(value,3)),String(div(value,2)),String(rem(value,3)),String(pow(value,2)));
}
console.log("scale",scale("255"),scale(null),String(scale(undefined)));
console.log("static","6"-true,null*4,undefined/2);
console.log("special",String(pow(-1,(1/0))),String(pow(Number("bad"),0)),String(1/div(-0,2)),String(1/rem(-4,2)));
console.log("bigint",String(sub(9007199254740995n,2n)),String(mul(7n,-3n)),String(div(-13n,5n)),String(rem(-13n,5n)),String(pow(3n,20n)),typeof sub(5n,2n));
