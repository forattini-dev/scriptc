export type Event = { type: string; value: number };

export declare function decodeFromLines(source: AsyncIterable<number>): AsyncGenerator<Event>;
export declare function decodeFromLines(source: Iterable<number>): Generator<Event>;
