// @rust-only
// @no-engine
// @ts-nocheck
export {};
function show(label:string,value:string):void{
 let codes="";
 for(let i=0;i<value.length;i++){codes+=String(value.charCodeAt(i))+",";}
 console.log("codes",label,value.length,codes);
}
show("empty",String.fromCharCode());show("points-empty",String.fromCodePoint());
show("ascii",String.fromCharCode(65,66,67));
show("modulo",String.fromCharCode(-1,65536,65537,4294967361,1e100,-3.9));
show("nonfinite",String.fromCharCode(Number("bad"),1/0,-1/0,-0));
show("units",String.fromCharCode(0xd83d,0xde00,0xd800,65,0xdc00));
show("points",String.fromCodePoint(0,65,0x1f600,0x10ffff));
show("point-units",String.fromCodePoint(0xd800,65,0xdc00));
show("paired-points",String.fromCodePoint(0xd83d,0xde00));
function primitive(a:any,b:any):void{
 show("primitive-units",String.fromCharCode(a,b));
 show("primitive-points",String.fromCodePoint(a,b));
}
primitive("65",true);primitive(null,false);primitive("0x42",-0);
show("undefined",String.fromCharCode(undefined));
let sixel=0;for(let row=0;row<6;row++){sixel|=1<<row;}
show("sixel",String.fromCharCode(63+sixel));
const saved=String.fromCodePoint(0x1f600);const read=():string=>saved;show("capture",read());
