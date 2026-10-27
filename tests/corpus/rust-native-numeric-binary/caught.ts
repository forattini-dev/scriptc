// @rust-only
// @no-engine
// @ts-nocheck
export {};
function roundTrip(a:any,b:any):void{
 const result=a-b;
 try{
  try{throw result;}
  catch(error){console.log("inner",typeof error,String(error));throw error;}
 }catch(error){console.log("outer",typeof error,String(error));}
}
roundTrip(9007199254740995n,2n);
roundTrip(9,2);
try{throw 9007199254740993n;}
catch(error){console.log("direct",typeof error,String(error));}
