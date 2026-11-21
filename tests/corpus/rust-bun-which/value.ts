export {};

const locateValue = Bun.which;
console.log("function value", locateValue("scriptc-command-that-does-not-exist") === null);

const chooseValue = (override?: (name: string) => string | null) => override ?? Bun.which;
console.log("nullish function", chooseValue()("scriptc-command-that-does-not-exist") === null);
console.log("user function", chooseValue(name => name)("custom") === "custom");
