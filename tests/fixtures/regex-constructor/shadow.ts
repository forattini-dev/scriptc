function check(RegExp: any): void {
  console.log("shadow", RegExp === 42, typeof RegExp);
}
check(42);
console.log("global", typeof RegExp);
