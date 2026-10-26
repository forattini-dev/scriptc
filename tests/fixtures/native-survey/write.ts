const pattern = /a/;
pattern.test = (_value: string): boolean => true;
console.log(pattern.test("a"));
export {};
