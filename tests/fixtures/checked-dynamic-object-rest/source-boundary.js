class Copy {
  constructor(source) { const { ...rest } = source; this.rest = rest; }
}
function reject(source) {
  try { new Copy(source); console.log("unexpected-success"); }
  catch (error) { console.log(error.code, error.message); }
}
reject("😀");
reject([1]);
reject(Buffer.from("a"));
function callback() {}
reject(callback);
reject(new Error("hidden"));
