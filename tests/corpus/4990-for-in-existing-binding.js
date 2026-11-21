var key;
var seen = "";

for (key in { beta: 2, alpha: 1 }) {
  seen += key + ";";
}

for (const name in { x: 1, y: 2 }) {
  if (name === "x") continue;
  seen += name;
}

console.log(seen + "|" + key);
