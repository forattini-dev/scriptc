async function run(){class Box{async *items(){yield 1;yield 2;}}const o=new Box();const f=o.items;const it=f.call(o);const a=await it.next();const b=await it.next();return {first:a.value,firstDone:a.done,second:b.value,secondDone:b.done};}
run().then(out=>{console.log(out.first);console.log(out.firstDone);console.log(out.second);console.log(out.secondDone);});
