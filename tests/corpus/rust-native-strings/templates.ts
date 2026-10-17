// @rust-only
// @no-engine
console.log(`head\n${42} / ${true} / ${false} / ${null} / ${undefined} tail`);
console.log(`zero ${-0} | ${1 / 0} | ${-1 / 0} | ${0 / 0} | ${1e21} | ${1e-7}`);
console.log(`escapes \` \${literal} \\ \u{1F600}\t${"é"}\r\nend`);
function scalar(value: string | number | boolean | null | undefined): string { return `[${value}]`; }
console.log("union", scalar("x"), scalar(1), scalar(true), scalar(null), scalar(undefined));
function erased(value: unknown): string { return `${value}`; }
console.log("erased", erased(3), erased(-0), erased(false), erased(null), erased(undefined));
console.log("addition", "x" + 4, 5 + "y", "z" + false, "n" + null, "u" + undefined);
console.error(`stderr ${"checked"} ${2}`);
