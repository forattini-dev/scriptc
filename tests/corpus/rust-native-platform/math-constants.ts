// @rust-only
// @no-engine
console.log('constants', Math.E, Math.LN10, Math.LN2, Math.LOG10E, Math.LOG2E, Math.PI, Math.SQRT1_2, Math.SQRT2);
console.log('values', Math.PI === 3.141592653589793, Math.sin(Math.PI / 2), Math.SQRT2 * Math.SQRT2);
function shadow(Math: { PI: number }): number { return Math.PI; }
console.log('shadow', shadow({ PI: 42 }));
