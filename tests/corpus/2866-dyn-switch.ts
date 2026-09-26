// Closed scalar/unit switches over checked-dynamic values compare natively:
// one discriminant evaluation, lazy source-order tests, grouped cases, and
// the default arm for values outside the listed scalar kinds.
function classify(source: string): string {
  const value = JSON.parse(source);
  switch (value) {
    case undefined:
      return "undefined";
    case "node":
    case "electron":
      return `runtime:${value as string}`;
    case 7:
      return "seven";
    case false:
      return "false";
    default:
      return "other";
  }
}

console.log(classify('"node"'));
console.log(classify('"electron"'));
console.log(classify("7"));
console.log(classify("false"));
console.log(classify("null"));
console.log(classify("{}"));
