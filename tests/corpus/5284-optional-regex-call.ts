type Rule = { guard?: RegExp };

let calls = 0;
function subject(): string {
  calls += 1;
  return "ready";
}

function matches(rule: Rule): boolean {
  return rule.guard?.test(subject()) ?? false;
}

console.log(matches({}), calls);
console.log(matches({ guard: /ready/g }), calls);
console.log(matches({ guard: /ready/g }), calls);
