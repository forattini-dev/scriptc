class Copy {
  constructor(source) {
    Object.defineProperty(source, "hidden", { value: "secret", enumerable: false });
    const { ...rest } = source;
    this.rest = rest;
  }
}
try { new Copy({ visible: "kept" }); console.log("unexpected-success"); }
catch (error) { console.log(error.code, error.message); }
