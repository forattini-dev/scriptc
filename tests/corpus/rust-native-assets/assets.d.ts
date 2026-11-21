declare module "*.embedded" {
  const path: string;
  export default path;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
