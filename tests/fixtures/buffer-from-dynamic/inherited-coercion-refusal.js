function copy(value) { return Buffer.from(value); }
copy([Object.create({ valueOf() { return 257; } })]);
