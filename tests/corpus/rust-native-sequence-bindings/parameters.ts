// @rust-only
// @no-engine
export {};
function add([a,b]:number[]):number{return a+b;}
console.log("callee",add([1,2]),add([1]),add([]));
const rows=[[1,2],[3,4]];
console.log("callbacks",rows.map(([a,b])=>a+b).join(","));
function capture([value]:{value:number}[]):()=>number {return ()=>value.value;}
const object={value:2};const read=capture([object]);object.value=9;
console.log("captured",read());
function omitted([,value]:number[]):number{return Number(value);}
console.log("elision",omitted([1,8]));
