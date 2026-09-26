// Date.parse shares the native date-string parser with new Date(s).getTime().
// Exercise ISO timestamps, offsets, date-only forms, and invalid input.
const inputs = [
  "2026-07-17T00:00:00.000Z",
  "2026-07-17T12:34:56Z",
  "2026-07-17T12:34Z",
  "2026-07-17",
  "2026-07",
  "2026",
  "2026-07-17T12:00:00+05:30",
  "2026-07-17T12:00:00-08:00",
  "+010000-01-01T00:00:00.000Z",
  "bogus",
  "2026-13-01",
  "2026-02-30T12:00:00Z",
];
for (const input of inputs) {
  const parsed = Date.parse(input);
  console.log(input, Number.isNaN(parsed) ? "NaN" : parsed);
}
console.log(Date.parse("2026-07-17T12:34:56Z") === new Date("2026-07-17T12:34:56Z").getTime());
