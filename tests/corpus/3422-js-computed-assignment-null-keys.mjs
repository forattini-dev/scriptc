function check(receiver, key) {
  function right() { console.log("right"); return 1; }
  try { const result = (receiver[key] = right()); console.log(result); }
  catch (error) { console.log(error.name, error.message); }
}
check(null, { toString() { console.log("unexpected"); return "item"; } });
check(undefined, { toString() { console.log("unexpected"); return "item"; } });
check(null, Symbol("item"));
check(undefined, true);
