// @dynamic
import { importedMode, summary } from "importmapped";

const rendered: string = summary;
const mode: string = await importedMode();
console.log(rendered);
console.log(mode);
