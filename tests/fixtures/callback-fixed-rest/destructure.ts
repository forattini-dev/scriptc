function invoke(listener: (...args: any[]) => void) { listener({ value: 42 }); }
invoke(({ value }) => console.log(typeof value, value === 42));
