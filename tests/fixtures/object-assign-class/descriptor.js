class Options { count = 0; }
function copy(source) { Object.assign(target, source); }
const target = new Options();
const source = { count: 7 };
Object.defineProperty(source, "hidden", { value: "secret", enumerable: false });
try { copy(source); console.log("copied", target.count); }
catch (error) { console.log(error.code, target.count); }
