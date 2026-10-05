// @no-engine
class RestOnly {
  constructor(source) { const { ...rest } = source; this.rest = rest; }
}
class WithHead {
  constructor(source) { const { item: renamed, ...rest } = source; this.item = renamed; this.rest = rest; }
}
function report(source) {
  try { new RestOnly(source); } catch (error) { console.log(error.name, error.message); }
  try { new WithHead(source); } catch (error) { console.log(error.name, error.message); }
}
report(undefined);
report(null);
