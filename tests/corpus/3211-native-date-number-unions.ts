// @rust-only
// @no-engine
function time(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}
function numberFirst(value: number | Date): string {
  if (typeof value === 'number') return 'number:' + String(value);
  return value.toISOString();
}
function optional(value: Date | undefined): string {
  if (value === undefined) return 'missing';
  return value.toISOString();
}
const date = new Date('2026-01-02T03:04:05.006Z');
console.log(time(date), time(123));
console.log(numberFirst(date), numberFirst(123));
console.log(optional(undefined), optional(date));
interface FileTimes {
  utimes(path: string, atime: number | Date, mtime: number | Date): number;
}
const filesystem: FileTimes = { utimes(_path, atime, mtime) { return time(atime) + time(mtime); } };
console.log(filesystem.utimes('file', 7, date));
