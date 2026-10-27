// @rust-only
// @no-engine
export {};
const source=[10,20,30];
const [a,,c,d]=source;
console.log("numbers",a,c,d,typeof d);
const [label,number]=["label",7] as const;
console.log("tuple",label,number);
const object={value:4};
const [alias]=[object];
console.log("identity",alias===object,alias.value);
const functions:any=[(): string => "callable"];
const [call]=functions;
console.log("function",String(call()),call===functions[0]);
let [mutable]=[1];
mutable=8;
console.log("mutable",mutable);
let evaluations=0;
function input():number[]{evaluations+=1;return source;}
const [first,second]=input();
source.pop();source.pop();source.push(90);
console.log("snapshot",evaluations,first,second,source.join(","));
