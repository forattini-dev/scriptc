import value from "./cycle-a.mts";
try { console.log("cycle-value", value); } catch (error: any) { console.log("cycle-tdz", String(error.name)); }
