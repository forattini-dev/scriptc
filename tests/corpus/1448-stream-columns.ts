// process.stdout/stderr terminal dimensions under the piped (non-TTY) harness: Node's
// answer is undefined — the lowering's `number | undefined` union takes the
// undefined arm, byte-compared against Node. The receiver match sees through
// the as-cast widening pattern (@types/node declares a plain `number`, so
// honest code casts the undefined possibility back in); the ?? fallback and
// undefined-comparison probes exercise both consumers. The TTY arm (a real
// width off ioctl(TIOCGWINSZ)) is exercised by hand under `script -q
// /dev/null` where both worlds report the pty's width — a pty cannot be
// allocated here.
const stdoutCols = (process.stdout as typeof process.stdout & { columns?: number }).columns;
const stderrCols = (process.stderr as typeof process.stderr & { columns?: number }).columns;
const stdoutRows = (process.stdout as typeof process.stdout & { rows?: number }).rows;
const stderrRows = (process.stderr as typeof process.stderr & { rows?: number }).rows;
console.log(stdoutCols === undefined ? "no-stdout-width" : "stdout-width");
console.log(stderrCols === undefined ? "no-stderr-width" : "stderr-width");
console.log(stdoutRows === undefined ? "no-stdout-height" : "stdout-height");
console.log(stderrRows === undefined ? "no-stderr-height" : "stderr-height");
console.log(stderrCols ?? 80);
console.log(stdoutRows ?? 24);
function getColumns(): number {
  return (
    (process.stderr as typeof process.stderr & { columns?: number }).columns ??
    120
  );
}
console.log(getColumns());
