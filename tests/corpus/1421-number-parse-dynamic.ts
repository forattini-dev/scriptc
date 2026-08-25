// Number.parseFloat / Number.parseInt are the global parsers (the spec
// aliases them) and lower through the same native implementations.
console.log(Number.parseFloat("3.14"), Number.parseFloat("2e3"), Number.parseFloat("  -7.5abc"));
console.log(Number.parseFloat("x"), Number.parseFloat("Infinity"));
console.log(Number.parseInt("42", 10), Number.parseInt("ff", 16), Number.parseInt("0x1f", 16));
console.log(Number.parseInt("x", 10), Number.parseInt("-101", 2));
console.log(Number.parseInt("0x20"), Number.parseInt("077"));
