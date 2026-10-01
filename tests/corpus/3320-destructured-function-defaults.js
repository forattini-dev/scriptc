// @rust-only
// @no-engine
const [constant = () => {}] = [];
let [mutable = () => {}] = [];
var [variable = () => {}] = [];
console.log(constant.name, mutable.name, variable.name);
constant();
mutable();
variable();
