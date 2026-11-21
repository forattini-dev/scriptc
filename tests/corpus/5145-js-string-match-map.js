// @ts-nocheck
/** @type {{ test: RegExp, resolve: (value: any) => any }} */
const timestamp = {
  test: /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/,
  resolve(str) {
    const match = str.match(timestamp.test);
    if (!match) throw new Error("invalid timestamp");
    const [, year, month, day] = match.map(Number);
    return `${year}-${month}-${day}`;
  },
};

console.log(String(timestamp.resolve("2026-11-07")));
