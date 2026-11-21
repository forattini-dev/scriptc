let trace='';function run(){const x={...{a:1},get b(){return 2;},...{c:3}};return {value:x.b,keys:Object.keys(x).join(','),trace,extra:x.c};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
