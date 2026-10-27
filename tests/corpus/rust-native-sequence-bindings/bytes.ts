// @rust-only
// @no-engine
export {};
const bytes=new Uint8Array([65,66]);
const [a,b,c]=bytes;
const [x,y,z]=Buffer.from("AB");
console.log("bytes",a,b,c,x,y,z);
const dynamic:any=bytes;
const [first]=dynamic;
console.log("dynamic",String(first));
