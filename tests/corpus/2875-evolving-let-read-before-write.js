// Evolving JavaScript lets start as undefined. A later static write must not
// promote the slot to a scalar before its earlier reads, and a conditional
// write must retain that same undefined possibility.
let direct;
console.log(direct);
direct = 42;
console.log(direct);

let conditional;
if (false) conditional = "set";
console.log(conditional);
