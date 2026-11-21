const first = () => 1;
const second = () => 2;
const values = new Set([first, second]);
for (const value of values) {
  console.log(value === first, value === second, value());
}
