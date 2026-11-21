const root: any = globalThis;
root.unescape = (value: string) => "custom:" + value;
console.log(unescape("%41"));
