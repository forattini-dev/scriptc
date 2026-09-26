const [[x, y, z] = [4, 5, 6]] = [];
console.log(x, y, z);
let [[a, b] = [7, 8]] = [];
console.log(a, b);
var [[c] = [9]] = [];
console.log(c);
let once = true;
for (var [[d, e] = [10, 11]] = []; once; once = false) {
  console.log(d, e);
}
const [[f] = [12]] = [[13]];
console.log(f);
