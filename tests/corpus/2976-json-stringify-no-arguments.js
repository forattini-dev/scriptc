const value = JSON.stringify();
console.log(value, typeof value, value === undefined);
console.log(JSON.stringify() === undefined);
function missing() { return JSON.stringify(); }
function observe(value) { console.log(value, typeof value); }
const record = { value: JSON.stringify() };
console.log(missing(), missing() === undefined, record.value === undefined);
observe(JSON.stringify());
