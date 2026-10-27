// @rust-only
// @no-engine
export {};
const readers={first:()=>-1,second:()=>-1};
let iteration=0;
for(let [a,b] of [[1,2],[3,4]]) {
 if(iteration===0) readers.first=()=>Number(a)+Number(b);
 else readers.second=()=>Number(a)+Number(b);
 iteration+=1;
 a=Number(a)+10;
}
console.log("fresh",readers.first(),readers.second());
let sum=0;
for(const [,value] of [[1,2],[3,4]]){sum+=Number(value);}
console.log("elision",sum);
for(const [] of [[],[1]]){console.log("empty-pattern");}
