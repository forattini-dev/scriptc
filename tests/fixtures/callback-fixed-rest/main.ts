function invoke(listener: (...args: any[]) => void) {
  listener({ value: 'one' }, 2, 'three');
}

invoke((message) => {
  console.log(typeof message.value, message.value === 'one');
});
