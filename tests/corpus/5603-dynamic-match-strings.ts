const pattern: any = "a+";
const matched: any = "caaab".match(pattern);
const number: any = 42;
const numeric: any = "x42y".match(number);
console.log("strings", matched[0], matched.index, numeric[0], numeric.index);
