const callback: any = (value: string) => {
  console.log(value);
  return 1;
};

function finish(): Promise<void> {
  return Promise.resolve("reaction").then(callback);
}

finish().then(() => console.log("done"));
