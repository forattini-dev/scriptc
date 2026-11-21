const cases = ["", "%", "%0", "%00", "%01", "%09", "%20", "%2b", "%2B", "%7F", "%80", "%FF", "%G0", "%0G", "%u", "%u0", "%u0041", "%u004a", "%uFFFF", "%uD800", "%uDC00", "%U0041", "%u00G1", "%%41", "%2520", "+", "é%20€", "%F0%9F%92%A9", "%uD83D%uDCA9", "%41%u0042", "%u0000", "%u12345"];
for (const source of cases) {
  const output = unescape(source);
  const units: number[] = [];
  for (let i = 0; i < output.length; i++) units.push(output.charCodeAt(i));
  console.log("case", source || "<empty>", units.length ? units.join(",") : "<empty>");
}
