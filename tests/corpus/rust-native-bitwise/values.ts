// @rust-only
// @no-engine
// @ts-nocheck
export {};
function bits(a:any,b:any):void{
 console.log("bits",String(a&b),String(a|b),String(a^b),String(a<<b),String(a>>b),String(~a));
}
bits(4294967297,2);bits(-9.75,33);bits("15","2");bits(true,false);
bits(null,undefined);bits(Number("bad"),1/0);bits(-0,-0);
bits(9007199254740991,2147483648);bits(1e100,-33);
bits(123456789012345678901234567890n,5n);bits(-17n,-2n);
console.log("unsigned",-1>>>0, "31" >>> "1", null >>> undefined);
console.log("not",String(~"7"),String(~true),String(~null),String(~undefined));
