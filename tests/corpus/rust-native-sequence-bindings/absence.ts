// @rust-only
// @no-engine
// @ts-nocheck
export {};
const sparse:any=JSON.parse('[1,2,3]');
delete sparse[1];
const [a,b,c,d]=sparse;
console.log("sparse",String(a),String(b),String(c),String(d),b===undefined,d===undefined);
const [head,tail]=[5];
console.log("short",head,String(tail),typeof tail);
const [empty]=[];
console.log("empty",empty===undefined);
const []=sparse;
function invalid(value:any):void {
 try {const []=value;console.log("unexpected");}
 catch(error){console.log("invalid-empty",error instanceof TypeError,String(error.message));}
 try {const [item]=value;console.log("unexpected",String(item));}
 catch(error){console.log("invalid-one",error instanceof TypeError,String(error.message));}
}
invalid(undefined);invalid(null);invalid(0);invalid(true);invalid(3n);invalid(Symbol("x"));invalid({});invalid({0:1,length:1});

function parameter([ignored]:any):void {}
function invalidParameter(value:any):void {
 try {parameter(value);console.log("unexpected-parameter");}
 catch(error){console.log("invalid-parameter",error instanceof TypeError,String(error.message));}
}
invalidParameter(undefined);invalidParameter(null);invalidParameter(0);invalidParameter(true);invalidParameter(3n);invalidParameter(Symbol("x"));invalidParameter({});
try {const []=null;}catch(error){console.log("literal-null",error instanceof TypeError,String(error.message));}
