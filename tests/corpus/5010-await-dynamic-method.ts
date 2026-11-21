const service: any = {
  run: () => Promise.resolve("ok"),
};

async function main(): Promise<any> {
  return await service.run();
}

void main().then((value) => console.log(value === "ok"));
