function write(target, key) { return (target[key] = 42); }
console.log(write({}, { toString() { return "item"; } }));
