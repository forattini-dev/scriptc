let trace='';function run(){const source={a:9};const x={get a(){trace+='g';return 2;},...source};return {value:x.a,keys:Object.keys(x).join(','),trace,extra:0};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
