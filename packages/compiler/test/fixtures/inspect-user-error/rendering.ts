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
console.log(e);
console.log([1, e]);
const deep = new DeepError("nested", "fs");
console.log(deep);
console.log([deep]);
class Bare extends Error {}
const bare = new Bare("plain");
console.log(bare);
console.log(new AppError("multi\nline", "EML"));
