function shadow(NaN: number, Infinity: number): number {
  return NaN + Infinity;
}
console.log(shadow(2, 3));
function nested(): number {
  const Infinity = 7;
  const NaN = 4;
  return Infinity - NaN;
}
console.log(nested());
