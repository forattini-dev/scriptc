// The remaining regex slice fences. Rust supports stateful test/exec;
// these first calls must no longer report SC1121. The d/v flags are
// outside the slice; .groups needs a statically-known regex (named
// capture groups themselves compile — corpus 2604); method-as-value has
// no value form; regexes stay out of union arms (ARRAYS of regexes
// compile — corpus 2448).
const g = /ab/g.test("abab");
const y = /ab/y.test("abab");
const indices = /cat/d;
const sets = /[\p{L}]/v;
const asValue = /x/.test;
const maybe: RegExp | undefined = /a/;
function readGroups(re: RegExp): void {
  const m = re.exec("2024-07");
  if (m) console.log(m.groups);
}
readGroups(/(?<year>\d{4})/);
