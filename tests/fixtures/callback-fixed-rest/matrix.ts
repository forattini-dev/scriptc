function invoke(listener: (...args: any[]) => void, value: any) {
  listener();
  listener(value);
  listener(value, 'extra');
  listener(value, undefined, 3);
}

const values: any[] = [undefined, null, false, 0, 1, 'text', { value: 7 }, [1, 2]];
for (let i = 0; i < values.length; i++) {
  let calls = 0;
  const listener: (...args: any[]) => void = (first = 'default', second = 'fallback') => {
    calls++;
    console.log(i, calls, typeof first, first === undefined, first === null,
      first === false, first === 0, first === 1, first === 'text', second === 'fallback');
  };
  invoke(listener, values[i]);
}
