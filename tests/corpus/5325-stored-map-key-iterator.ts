function evictOldest(values: Map<string, number>, count: number): void {
    const keys = values.keys();
    for (let index = 0; index < count; index++) {
        const next = keys.next();
        if (next.done) break;
        values.delete(next.value);
    }
}

const values = new Map<string, number>();
values.set("first", 1);
values.set("second", 2);
values.set("third", 3);
evictOldest(values, 2);
console.log(values.size, values.has("first"), values.has("second"), values.has("third"));

const empty = new Map<string, number>();
evictOldest(empty, 2);
console.log(empty.size);
