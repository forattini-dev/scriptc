type Base = { tag: string };
type Wide = { tag: string; note?: string; "2"?: string; "10"?: string };
function narrow(p: Wide): Base { return p; }
function copy(p: Base): Base { return { ...p }; }
function show(p: Wide): void { const result = copy(narrow(p)); console.log("case", Object.keys(result).join("|"), Object.hasOwn(result,"note")); }
show({tag:"absent"}); show({note:undefined,tag:"present"}); show({"10":"ten",note:"n",tag:"numeric","2":"two"});
const __proto__ = "own"; const source = { tag: "proto", __proto__ };
function base(p: {tag:string;__proto__:string}): Base { return p; }
const proto = copy(base(source)); const erased: any = proto;
console.log("case", Object.hasOwn(proto,"__proto__"), erased.__proto__ === "own", Object.keys(proto).join("|"));
