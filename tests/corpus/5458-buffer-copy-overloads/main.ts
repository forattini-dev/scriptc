const source = Buffer.from([1, 2, 3, 4, 5]);

const whole = Buffer.from([9, 9, 9, 9, 9, 9, 9]);
console.log(source.copy(whole), whole.join(","));

const shifted = Buffer.from([9, 9, 9, 9, 9, 9, 9]);
console.log(source.copy(shifted, 2), shifted.join(","));

const ranged = Buffer.from([9, 9, 9, 9, 9, 9, 9]);
console.log(source.copy(ranged, 1, 2), ranged.join(","));

const bounded = Buffer.from([9, 9, 9, 9, 9, 9, 9]);
console.log(source.copy(bounded, 2, 1, 4), bounded.join(","));

const overlap = Buffer.from([1, 2, 3, 4, 5]);
console.log(overlap.copy(overlap, 1, 0, 4), overlap.join(","));

const typed = new Uint8Array(5);
console.log(Buffer.from([8, 7]).copy(typed, 1), Array.from(typed).join(","));
