type Context = { freq?: number };
const custom: any = { toFixed() { return 9; } };
function format(ctx: Context) { return (ctx.freq ?? 0).toFixed(2); }
try { console.log(typeof format({ freq: custom }), format({ freq: custom })); }
catch (error) { console.log('caught', error instanceof TypeError); }
