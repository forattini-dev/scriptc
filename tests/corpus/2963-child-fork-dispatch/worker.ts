process.on("message", (message: { value: number }) => {
  process.send?.({ value: message.value }, (error) => {
    if (error) throw error;
    if (message.value === 3) process.disconnect();
  });
});
process.send?.({ value: 0 });
