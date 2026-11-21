let pending: Promise<unknown> | undefined;
const touch = (): Promise<unknown> | undefined => pending;
pending = Promise.resolve(5);
console.log(touch() !== undefined);

const wait = (): Promise<void> => pending as Promise<void>;

void wait().then((): void => console.log("done"));
