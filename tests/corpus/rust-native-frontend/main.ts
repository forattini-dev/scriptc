// @rust-only
// @no-engine
type Score = number;
interface Named { name: string; }
const base: Score = 6;
let total: number = base * 7;
console.log("native", total, total > 40, !false);
total = total + 0.5;
if (total >= 42) {
  const total: string = "ação 😀";
  console.log(total);
  console.error("checked", true);
} else {
  console.log("wrong branch");
}
console.log("value", total);
