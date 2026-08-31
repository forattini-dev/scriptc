/**
 * @param {string} root
 * @param {string[]} entries
 * @param {boolean} includeRoot
 * @param {boolean} skipFallback
 */
function* candidates(root, entries, includeRoot, skipFallback) {
  const rootResume = includeRoot && (yield [root, "root"]);
  const fallbackResume = skipFallback || (yield ["fallback", "fallback"]);
  Boolean(rootResume);
  Boolean(fallbackResume);
  for (const entry of entries) {
    yield [entry, "entry"];
  }
}

const first = candidates("/tmp", ["a", "b"], true, false);
let firstResult = first.next(false);
while (!firstResult.done) {
  const pair = firstResult.value;
  console.log(pair[1], pair[0]);
  firstResult = first.next(false);
}

const second = candidates("ignored", ["c"], false, true);
let secondResult = second.next(false);
while (!secondResult.done) {
  const pair = secondResult.value;
  console.log(pair[1], pair[0]);
  secondResult = second.next(false);
}
