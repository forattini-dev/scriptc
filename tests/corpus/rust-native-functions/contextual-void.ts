function invoke(callback: () => void): void {
  callback();
}

let effects = 0;
invoke(() => {
  effects += 1;
  return { ignored: true };
});
console.log("contextual void", effects);
