let trace='';function run(){const x={...null,get a(){trace+='g';return 2;}};const value=x.a;return {value,keys:Object.keys(x).join(','),trace,extra:0};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
