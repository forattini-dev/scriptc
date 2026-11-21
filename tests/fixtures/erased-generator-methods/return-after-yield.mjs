class Box{async *items(n){yield n;yield n+1;}}async function run(){const o=new Box(),f=o.items,it=f.call(o,1);const a=await it.next(),b=await it.return(7);return {a:a.value,ad:a.done,b:b.value,bd:b.done};}
run().then(out=>{console.log(out.a);console.log(out.ad);console.log(out.b);console.log(out.bd);});
