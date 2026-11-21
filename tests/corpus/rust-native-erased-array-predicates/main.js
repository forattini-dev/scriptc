// Erased JavaScript arrays: every/some resolve on the live value.
function verdicts(checks) {
  return {
    all: checks.every((check) => check.verdict === "ok"),
    any: checks.some((check) => check.verdict === "missing"),
  };
}

console.log(JSON.stringify(verdicts([{ verdict: "ok" }, { verdict: "ok" }])));
console.log(JSON.stringify(verdicts([{ verdict: "ok" }, { verdict: "missing" }])));
console.log(JSON.stringify(verdicts([])));

const visited = [];
const values = [3, 8, 1, 9];
const firstLarge = values.some((value, index) => {
  visited.push(index);
  return value > 5;
});
console.log(firstLarge, visited.join(","));

let calls = 0;
console.log([7, 8, 9].every(() => { calls += 1; return calls < 2; }), calls);

const holder = { limit: 2 };
console.log([1, 2].every(function (value) { return value <= this.limit; }, holder));

const parsed = JSON.parse('{"checks":[{"verdict":"ok"},{"verdict":"missing"}],"empty":[]}');
console.log(parsed.checks.every((check) => check.verdict === "ok"), parsed.checks.some((check) => check.verdict === "missing"));
console.log(parsed.empty.every(() => false), parsed.empty.some(() => true));
const order = [];
console.log(parsed.checks.some((check, index, all) => { order.push(`${index}/${all.length}`); return check.verdict === "missing"; }), order.join(" "));
const every = parsed.checks.every;
console.log(typeof every, every === parsed.empty.every);
