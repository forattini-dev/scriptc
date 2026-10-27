// @rust-only
// @no-engine
export {};
const text="AÃ°Å¸Ëœâ‚¬B";
const [first,astral,last,missing]=text;
console.log("points",first,astral,String(astral).length,last,missing===undefined);
const lone:any=JSON.parse('"\\ud800x\\udc00"');
const [high,middle,low,end]=lone;
console.log("units",String(high).charCodeAt(0),String(middle),String(low).charCodeAt(0),end===undefined);
const [,second]=text;
console.log("elision",second);
const [empty]="";
console.log("empty",empty===undefined);
