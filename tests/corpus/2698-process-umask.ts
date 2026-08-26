// process.umask() reads and updates process-wide creation permissions. Restore
// the inherited value so this differential case cannot affect later work.
const original = process.umask();
const beforeSet = process.umask(0o027);
console.log(beforeSet === original);
console.log(process.umask() === 0o027);
console.log(process.umask(original) === 0o027);
console.log(process.umask() === original);
