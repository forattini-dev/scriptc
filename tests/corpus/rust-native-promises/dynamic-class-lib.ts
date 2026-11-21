console.log("class module initialized");
export class CustomError extends Error {
  constructor() { super("native failure"); this.name = "CustomError"; }
}
