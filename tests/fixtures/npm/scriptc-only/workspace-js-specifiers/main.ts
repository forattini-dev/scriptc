import { bare, value } from "workspace-js-specifiers-b";

const output = value as string;
const bareOutput = bare as string;
console.log(output, bareOutput);
