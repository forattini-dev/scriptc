// @ts-nocheck
function Collection() {
  return function hook(value) {
    return `hook:${value}`;
  };
}

const hook = new Collection();
console.log(`${typeof hook}|${hook("native")}`);
