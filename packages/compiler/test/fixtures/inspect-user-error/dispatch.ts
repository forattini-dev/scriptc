import { inspect } from "node:util";
class AppError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
class DeepError extends AppError {
  at: string;
  constructor(message: string, at: string) {
    super(message, "EDEEP");
    this.name = "DeepError";
    this.at = at;
  }
}
const e = new AppError("boom", "EAPP");
const deep = new DeepError("nested", "fs");
function show(err: Error): void {
  console.log(err);
}
show(e);
show(deep);
show(new TypeError("native"));
show(new Error("plain"));
console.log(inspect({ wrap: [deep] }, { depth: 0 }));
console.log(inspect({ wrap: [deep] }, { depth: 1 }));
console.log(inspect(e, { depth: 0 }));
console.log([1, [2, e]]);
