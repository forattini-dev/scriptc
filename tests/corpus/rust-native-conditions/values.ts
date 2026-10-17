function test(value: any): void { if (value) console.log("yes"); else console.log("no"); }
test(0); test(-0); test(0/0); test(""); test(null); test(undefined); test(false);
test(1); test("0"); test(true); test({}); test([]); test((): void => {});
if (1) console.log("literal");
