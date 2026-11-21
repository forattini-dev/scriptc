const rows = ["a"];

function index(): number {
  console.log("index");
  return 0;
}

function suffix(): string {
  console.log("suffix");
  return "b";
}

const result = (rows[index()] += suffix());
console.log(result, rows[0]);
