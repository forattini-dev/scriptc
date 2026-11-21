function report(out: string): void {
  console.log(out); console.log(typeof out); console.log(out.length); console.log(out.includes('.'));
}
function format(ctx: { frequency?: number }): string { return (ctx.frequency ?? 0).toFixed(2); }
function nullable(ctx: { frequency: number | null }): string { return (ctx.frequency ?? 0).toFixed(2); }
report(format({frequency:1.25}));
report(format({}));
report(nullable({frequency:null}));
report(nullable({frequency:2.5}));
report(format({frequency:0}));
report(format({frequency:NaN}));
report(format({frequency:Infinity}));
report(format({frequency:-3.125}));
