let task: any = (left: any, right: any) => `${left}:${right}`;
const args: any[] = ["native", "rust"];
console.log(task(...args) === "native:rust");
