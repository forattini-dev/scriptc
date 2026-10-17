/** @type {((s: string) => void) | null} */
let sink = null;
function clearSink() { sink = null; }
function observe() {
  if (sink) {
    clearSink();
    if (sink) console.log("stale"); else console.log("live-null");
    if (!sink) console.log("negated-null");
  }
}
sink = () => { console.log("unexpected"); };
observe();
