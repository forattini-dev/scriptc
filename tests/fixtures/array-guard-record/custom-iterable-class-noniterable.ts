class NotIterable { marker: number = 1; }
try { for (const x of new NotIterable() as any) console.log(x); }
catch (e) { console.log(e instanceof TypeError, (e as Error).message); }
