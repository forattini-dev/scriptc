// @rust-only
// @no-engine
export {};
let order = 0;
function receiver(): (message: string) => void { order = order + 1; console.log("receiver", order); return console.log; }
function message(): string { order = order + 1; console.log("message", order); return "ordered sink"; }
receiver()(message());
function make(): (message: string) => void { const captured = console.error; return (message: string) => captured(message); }
const write = make();
write("captured error");
function choose(error: boolean): (message: string) => void { return error ? console.error : console.log; }
choose(false)("chosen stdout");
choose(true)("chosen stderr");
console.log("order", order);
