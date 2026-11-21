interface Input { backoff?: number | null; now: number; }
function direct(input: Input): string {
  const value=input.backoff??null;
  if (value!=null && input.now<value) return new Date(value!).toISOString();
  return 'no';
}
function aliased(input: Input): string {
  const value=input.backoff??null; const holding=value!=null && input.now<value;
  for (const item of [1]) { if (holding) return new Date(value!).toISOString(); }
  return 'no';
}
function negated(input: Input): string {
  const value=input.backoff??null; const outside=value==null || input.now>=value;
  if (!outside) return new Date(value!).toISOString();
  return 'no';
}
function report(out: string): void { console.log(out); console.log(typeof out); console.log(out.length); console.log(out.startsWith('1970')); }
report(direct({backoff:1000,now:0}));
report(aliased({backoff:1000,now:0}));
report(aliased({backoff:null,now:0}));
report(negated({backoff:1000,now:0}));
report(negated({now:0}));
report(aliased({backoff:0,now:0}));
