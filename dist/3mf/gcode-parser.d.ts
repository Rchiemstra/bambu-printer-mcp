import type { Readable } from "node:stream";
import { type GcodeParseSummary, type ParseOptions } from "./gcode-types.js";
export declare function parseGcodeStream(stream: Readable, options?: ParseOptions): Promise<GcodeParseSummary>;
