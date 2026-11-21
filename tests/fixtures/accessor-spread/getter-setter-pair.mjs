let trace='';function run(){const source={b:3};const x={...source,get a(){return this.b;},set a(v){this.b=v;}};x.a=9;return {value:x.a,keys:Object.keys(x).join(','),trace,extra:x.b};}const out=run();
console.log(out.value);
console.log(out.keys);
console.log(out.trace);
console.log(out.extra);
