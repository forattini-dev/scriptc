class Holder {
  constructor(options) { options.fn(); }
}
function run() {
  const tx = new Holder({ fn: () => tx });
  return tx;
}
try { run(); console.log("no error"); }
catch (error) { console.log(error instanceof ReferenceError); }
