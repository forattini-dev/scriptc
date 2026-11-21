// @ts-nocheck
function pick(choices, query) {
  return choices.includes(query);
}

if (pick(["alpha", "beta"], "beta")) console.log("yes");
else console.log("no");
