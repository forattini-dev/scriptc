// @no-engine
function show(date: Date): void {
  console.log(date.getTime(), date.getFullYear(), date.getMonth(), date.getDate(),
    date.getDay(), date.getHours(), date.getMinutes(), date.getSeconds(),
    date.getMilliseconds(), date.getTimezoneOffset());
}
show(new Date(2026, 0));
show(new Date(2024, 1, 29));
show(new Date(2025, 1, 29));
showCivil(new Date(0, 0, 1));
show(new Date(99, 0, 1));
showCivil(new Date(100, 0, 1));
show(new Date(2024, -1, 0, 25, -1, 61, -1));
show(new Date(2024.9, 1.9, 2.9, 3.9, 4.9, 5.9, 6.9));
show(new Date(2024, 0, undefined));
show(new Date(NaN, 0));
show(new Date(2024, Infinity));
show(new Date(2024, 0, 1e300));
// US overlap/gap, Lord Howe's half-hour gap, Apia's skipped civil day,
// and Sao Paulo's midnight gap. The timezone harness runs all these inputs.
show(new Date(2024, 2, 10, 2, 30));
show(new Date(2024, 10, 3, 1, 30));
show(new Date(2024, 9, 6, 2, 15));
show(new Date(2024, 3, 7, 1, 45));
show(new Date(2011, 11, 30, 12));
show(new Date(2018, 10, 4, 0, 30));
// Local construction clips AFTER conversion to UTC, including extended years.
show(new Date(275760, 8, 13, 12));
show(new Date(-271821, 3, 19, 12));
showCivil(new Date(1800, 0, 1, 0, 0, 0, 123));

// Historical IANA data differs between the OS and Node's ICU (documented
// runtime limitation). Check the civil constructor contract in every zone;
// pin its exact epoch in UTC, whose offset is independent of that database.
function showCivil(date: Date): void {
  console.log(date.getFullYear(), date.getMonth(), date.getDate(), date.getDay(),
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  if (process.env.TZ === 'UTC') show(date);
}
