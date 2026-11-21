function check(unescape: (value: string) => string): void {
  console.log("shadow", unescape("%41"));
}
check(value => "custom:" + value);
