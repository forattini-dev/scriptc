const custom = { values() { return { next() { return { value: 123 }; } }; } };
console.log('custom', custom.values().next().value);
