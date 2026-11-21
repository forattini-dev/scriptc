let trace='';function run(){const source={a:1,b:3};const x={...source,get a(){trace+='g';return 2;}};const value=x.a;return {value,keys:Object.keys(x).join(','),trace,extra:x.b};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
