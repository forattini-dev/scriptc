class Options { count = 0; }
const target = new Options();
function copy(source) { Object.assign(target, source); }
try { copy({ count: 7, extra: true }); console.log("copied", target.count); }
catch (error) { console.log(error.code, target.count); }
