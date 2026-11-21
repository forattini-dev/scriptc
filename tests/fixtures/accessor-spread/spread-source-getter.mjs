let trace='';function run(){const source={get a(){trace+='s';return 1;}};const x={...source,get b(){trace+='g';return 2;}};const value=x.b;return {value,keys:Object.keys(x).join(','),trace,extra:x.a};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
