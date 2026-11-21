const pattern: any = { [Symbol.match]: 7 };
try { "abc".match(pattern); } catch (error) { console.log("error", (error as Error).name); }
