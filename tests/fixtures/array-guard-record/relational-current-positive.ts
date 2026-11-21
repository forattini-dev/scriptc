// @ts-nocheck
console.log(Object(1n) < 2n);
try { console.log(Symbol('x') + 1); }
catch (error) { console.log('symbol', error instanceof TypeError); }
