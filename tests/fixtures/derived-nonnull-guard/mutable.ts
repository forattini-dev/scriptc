// @ts-nocheck
function run(x:number|null,n:number){let value=x??null;const holding=value!=null&&n<value;value=null;if(holding)return new Date(value!).toISOString();return 'no';}
console.log(run(1000,0));
