// @rust-only
// @no-engine
import type { Stats } from "node:fs";
import { triple } from "#math";
interface ProjectInput { stat: Stats; env: NodeJS.ProcessEnv; }
const score: ProjectScore = 14;
console.log("project", triple(score));
