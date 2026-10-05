function check(target) {
  const events = [];
  function receiver() { events.push("receiver"); return target; }
  function key() { events.push("key"); return "item"; }
  function right() { events.push("right"); return { value: 7 }; }
  const result = (receiver()[key()] = right());
  result.value = 9;
  console.log(events.join(","), result === target.item, target.item.value);

  let name = "old";
  console.log((target[name] = (name = "new")), target.old, target.new, name);

  let current = target;
  function replaceReceiver() { current = {}; return 42; }
  console.log((current["answer"] = replaceReceiver()), target.answer, current.answer);

  function failKey(shouldThrow) { events.push("fail-key"); if (shouldThrow) throw new Error("key failed"); return "item"; }
  function failRight(shouldThrow) { events.push("fail-right"); if (shouldThrow) throw new Error("right failed"); return 1; }
  try { console.log((receiver()[failKey(true)] = right())); }
  catch (error) { console.log(error.name, error.message); }
  try { console.log((receiver()[key()] = failRight(true))); }
  catch (error) { console.log(error.name, error.message); }
  console.log(events.join(","));
}
check({});

function writeNull(receiver) {
  function key() { console.log("null-key"); return "item"; }
  function right() { console.log("null-right"); return 1; }
  try { console.log((receiver[key()] = right())); }
  catch (error) { console.log(error.name, error.message); }
}
writeNull(null);
writeNull(undefined);
