class Copy {
  constructor(source) { const { ...rest } = source; this.rest = rest; }
}
class PlainInstance { constructor() { this.field = "owned"; } }
try { new Copy(new PlainInstance()); console.log("unexpected-success"); }
catch (error) { console.log(error.code, error.message); }
