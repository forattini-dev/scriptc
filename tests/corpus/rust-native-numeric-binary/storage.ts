// @rust-only
// @no-engine
// @ts-nocheck
export {};
const left:any=9n;
const right:any=2n;
const result=left-right;
function read():any{return result;}
function capture(a:any,b:any):()=>any{
 const value=a*b;
 return ()=>value;
}
const captured=capture(7n,3n);
console.log("module",typeof result,String(result),typeof read(),String(read()));
console.log("capture",typeof captured(),String(captured()));
function distances(rows:any):any{
 const [r,g,b]=rows[0];
 const [pr,pg,pb]=rows[1];
 const dr=r-pr;const dg=g-pg;const db=b-pb;
 return dr*dr+dg*dg+db*db;
}
console.log("colors",String(distances([[20,30,40],[10,20,30]])));
