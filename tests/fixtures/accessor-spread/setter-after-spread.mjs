let trace='';function run(){const source={a:1};const x={...source,set a(v){trace+=String(v);},b:3};x.a=2;return {value:x.a,keys:Object.keys(x).join(','),trace,extra:x.b};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
