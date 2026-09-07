const source = [1, 2];
const destination = [0];
function later(): number[] { source[0] = 9; destination.push(8); return [3]; }
console.log(destination.push(...source, 4, ...later()), destination.join(","));
console.log(source.join(","));
const self = [1, 2];
console.log(self.push(...self, ...self), self.join(","));
const prepend = ["end"];
console.log(prepend.unshift(...["a"], "b", ...new Set(["c", "d"])), prepend.join(","));
