function install(callback: ((text: string) => void) | null): void {
  callback?.("message");
}

const writer = (text: unknown): unknown => {
  console.log(String(text));
  return 123;
};

install(writer);
install(null);
