class Holder {
  constructor(options) { this.fn = options.fn; this.value = 7; }
}
function run() {
  const tx = new Holder({ fn: () => tx });
  console.log(tx.fn() === tx, tx.fn().value);
}
run();
