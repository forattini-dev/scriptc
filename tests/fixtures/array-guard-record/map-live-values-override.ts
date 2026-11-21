const map = new Map<string, number>([['a', 1]]);
(map as any).values = function() { return [9]; };
for (const value of map.values()) console.log(value);
