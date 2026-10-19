type Wide = { kind: "a"; text: string; extra: string } | { kind: "b"; count: number; extra: string };
type Narrow = { kind: "b"; count: number } | { kind: "a"; text: string };
function narrow(input: Wide): Narrow { return input; }
function common(input: Wide): { kind: string } { return input; }
function show(input: Wide): void { const view = narrow(input); const a: any = input; const b: any = view; console.log("case", a === b, view.kind, Object.keys(view).join("|"), Object.keys(common(input)).join("|")); }
show({kind:"a",text:"x",extra:"a"}); show({extra:"b",count:3,kind:"b"});

type Large = {value:string;extra:string}; type Small = {value:string}; type Both = Large | Small;
function shrink(p:Large):Small {return p;} function larger(p:Large):Both{return p;} function smaller(p:Small):Both{return p;}
const large:Large={value:"x",extra:"keep"}; const small=shrink(large);
console.log("case", larger(large) === smaller(small));
