// Static Date.parse returns milliseconds or NaN without constructing a Date.
console.log(Date.parse("2024-01-02T03:04:05.006Z"));
console.log(Date.parse("2024-01-02T03:04:05+02:30"));
console.log(Number.isNaN(Date.parse("not a date")));
