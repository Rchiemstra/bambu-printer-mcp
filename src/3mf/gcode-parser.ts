import type { Readable } from "node:stream";
import {
  DEFAULT_PARSER_LIMITS,
  type Bounds3,
  type FilamentMetadata,
  type GcodeParseSummary,
  type MotionPrimitive,
  type ParseOptions,
  type ParserLimits,
  type SupportWarning,
  type Vec3,
} from "./gcode-types.js";
import { classifyRole } from "./gcode-roles.js";
import { SupportToolError, throwIfCancelled } from "../support/support-error.js";

const TAU = Math.PI * 2;

type ParserState = {
  position: Vec3;
  e: number;
  xyzAbsolute: boolean;
  eAbsolute: boolean;
  plane: "XY" | "XZ" | "YZ";
  role: string | null;
  layerIndex: number | null;
  zHeight: number | null;
  widthMm: number | null;
  heightMm: number | null;
  toolIndex: number | null;
  wipe: boolean;
};

function finiteNumber(value: string | undefined, name: string, line: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SupportToolError("MALFORMED_GCODE_NUMBER", `Invalid ${name} value on G-code line ${line}.`, {
      details: { line, name, value },
    });
  }
  return parsed;
}

function parseWords(command: string, line: number): Map<string, number> {
  const words = new Map<string, number>();
  const matcher = /([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(command)) !== null) {
    const key = match[1].toUpperCase();
    if (key === "G" || key === "M" || key === "T") continue;
    words.set(key, finiteNumber(match[2], key, line)!);
  }
  const residue = command
    .replace(/^\s*[GMT]\s*[-+]?\d+(?:\.\d+)?/i, "")
    .replace(/([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/g, " ");
  const malformed = /([XYZEFIJKRP])\s*([^\s]*)/i.exec(residue);
  if (malformed) {
    throw new SupportToolError("MALFORMED_GCODE_NUMBER", `Invalid ${malformed[1].toUpperCase()} value on G-code line ${line}.`, {
      details: { line, token: malformed[0] },
    });
  }
  return words;
}

function cloneVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function lineBounds(start: Vec3, end: Vec3): Bounds3 {
  return {
    min: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), z: Math.min(start.z, end.z) },
    max: { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y), z: Math.max(start.z, end.z) },
  };
}

function normalizePositive(angle: number): number {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

function directedSweep(start: number, end: number, clockwise: boolean, fullCircle: boolean): number {
  if (fullCircle) return clockwise ? -TAU : TAU;
  if (clockwise) {
    const amount = normalizePositive(start - end);
    return -(amount === 0 ? TAU : amount);
  }
  const amount = normalizePositive(end - start);
  return amount === 0 ? TAU : amount;
}

function angleOnSweep(angle: number, start: number, sweep: number): boolean {
  if (Math.abs(sweep) >= TAU - 1e-12) return true;
  if (sweep > 0) return normalizePositive(angle - start) <= sweep + 1e-12;
  return normalizePositive(start - angle) <= -sweep + 1e-12;
}

function arcGeometry(
  start: Vec3,
  end: Vec3,
  i: number,
  j: number,
  clockwise: boolean,
  fullCircle: boolean,
  line: number
): { center: { x: number; y: number }; sweep: number; length: number; bounds: Bounds3 } {
  const center = { x: start.x + i, y: start.y + j };
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const endRadius = Math.hypot(end.x - center.x, end.y - center.y);
  if (!(radius > 0) || (!fullCircle && Math.abs(endRadius - radius) > Math.max(0.01, radius * 0.001))) {
    throw new SupportToolError("INVALID_EXTRUSION_ARC", `Invalid I/J arc geometry on G-code line ${line}.`, {
      details: { line, radius, endRadius },
    });
  }
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = directedSweep(startAngle, endAngle, clockwise, fullCircle);
  const planarLength = radius * Math.abs(sweep);
  const length = Math.hypot(planarLength, end.z - start.z);
  const xs = [start.x, end.x];
  const ys = [start.y, end.y];
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (angleOnSweep(angle, startAngle, sweep)) {
      xs.push(center.x + radius * Math.cos(angle));
      ys.push(center.y + radius * Math.sin(angle));
    }
  }
  return {
    center,
    sweep,
    length,
    bounds: {
      min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(start.z, end.z) },
      max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(start.z, end.z) },
    },
  };
}

function parseList(value: string): string[] {
  return value.split(/\s*;\s*/).map((entry) => entry.trim()).filter(Boolean);
}

function metadataFromHeaders(headers: Map<string, string>): FilamentMetadata[] {
  const diameters = parseList(headers.get("filament_diameter") ?? "");
  const densities = parseList(headers.get("filament_density") ?? "");
  const types = parseList(headers.get("filament_type") ?? "");
  const colors = parseList(headers.get("filament_colour") ?? headers.get("filament_color") ?? "");
  const count = Math.max(diameters.length, densities.length, types.length, colors.length);
  return Array.from({ length: count }, (_, toolIndex) => ({
    toolIndex,
    diameterMm: Number.isFinite(Number(diameters[toolIndex])) && Number(diameters[toolIndex]) > 0
      ? Number(diameters[toolIndex])
      : null,
    densityGcm3: Number.isFinite(Number(densities[toolIndex])) && Number(densities[toolIndex]) > 0
      ? Number(densities[toolIndex])
      : null,
    type: types[toolIndex] ?? null,
    color: colors[toolIndex] ?? null,
  }));
}

async function* boundedLines(
  stream: Readable,
  limits: ParserLimits,
  signal?: AbortSignal,
  deadlineMs?: number
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  let total = 0;
  for await (const rawChunk of stream) {
    throwIfCancelled(signal, deadlineMs);
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > limits.maxGcodeBytes) {
      stream.destroy();
      throw new SupportToolError("GCODE_LIMIT_EXCEEDED", "Selected G-code exceeds the byte limit.");
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const rawLine = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (rawLine.length > limits.maxLineBytes) {
        stream.destroy();
        throw new SupportToolError("GCODE_LINE_LIMIT_EXCEEDED", "A G-code line exceeds the configured limit.");
      }
      yield rawLine.subarray(0, rawLine.at(-1) === 0x0d ? rawLine.length - 1 : rawLine.length).toString("utf8");
    }
    if (pending.length > limits.maxLineBytes) {
      stream.destroy();
      throw new SupportToolError("GCODE_LINE_LIMIT_EXCEEDED", "A G-code line exceeds the configured limit.");
    }
  }
  if (pending.length > 0) yield pending.toString("utf8");
}

export async function parseGcodeStream(stream: Readable, options: ParseOptions = {}): Promise<GcodeParseSummary> {
  const limits: ParserLimits = { ...DEFAULT_PARSER_LIMITS, ...options.limits };
  const state: ParserState = {
    position: { x: 0, y: 0, z: 0 },
    e: 0,
    xyzAbsolute: true,
    eAbsolute: true,
    plane: "XY",
    role: null,
    layerIndex: null,
    zHeight: null,
    widthMm: null,
    heightMm: null,
    toolIndex: null,
    wipe: false,
  };
  const warnings: SupportWarning[] = [];
  const headers = new Map<string, string>();
  const roles = new Set<string>();
  const layers = new Set<number>();
  let lineCount = 0;
  let motionCount = 0;
  let extrusionCount = 0;
  let featureTagsPresent = false;
  let slicerVersion: string | null = null;

  const emit = async (primitive: MotionPrimitive): Promise<void> => {
    if (++motionCount > limits.maxMotions) {
      stream.destroy();
      throw new SupportToolError("MOTION_LIMIT_EXCEEDED", "G-code exceeds the motion-command limit.");
    }
    if (primitive.positiveEDeltaMm > 0) extrusionCount += 1;
    await options.onPrimitive?.(primitive);
  };

  try {
    for await (const rawLine of boundedLines(stream, limits, options.signal, options.deadlineMs)) {
      lineCount += 1;
      if (lineCount > limits.maxLines) {
        throw new SupportToolError("GCODE_LINE_COUNT_EXCEEDED", "G-code exceeds the line-count limit.");
      }
      if ((lineCount & 0x3fff) === 0) throwIfCancelled(options.signal, options.deadlineMs);
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith(";")) {
        const comment = trimmed.slice(1).trim();
        const feature = /^FEATURE:\s*(.+)$/i.exec(comment);
        if (feature) {
          state.role = feature[1].trim();
          roles.add(state.role);
          featureTagsPresent = true;
          continue;
        }
        const width = /^LINE_WIDTH:\s*(\S+)/i.exec(comment);
        if (width) { state.widthMm = finiteNumber(width[1], "LINE_WIDTH", lineCount) ?? null; continue; }
        const height = /^LAYER_HEIGHT:\s*(\S+)/i.exec(comment);
        if (height) { state.heightMm = finiteNumber(height[1], "LAYER_HEIGHT", lineCount) ?? null; continue; }
        const zHeight = /^Z_HEIGHT:\s*(\S+)/i.exec(comment);
        if (zHeight) { state.zHeight = finiteNumber(zHeight[1], "Z_HEIGHT", lineCount) ?? null; continue; }
        if (/^CHANGE_LAYER\b/i.test(comment)) {
          state.layerIndex = state.layerIndex === null ? 0 : state.layerIndex + 1;
          layers.add(state.layerIndex);
          continue;
        }
        if (/^WIPE_START\b/i.test(comment)) { state.wipe = true; continue; }
        if (/^WIPE_END\b/i.test(comment)) { state.wipe = false; continue; }
        const header = /^([^=]+?)\s*=\s*(.*)$/.exec(comment);
        if (header) {
          const key = header[1].trim().toLowerCase();
          headers.set(key, header[2].trim());
          if ((key.includes("slicer") || key === "generated by") && !slicerVersion) slicerVersion = header[2].trim();
        }
        continue;
      }

      const semicolon = trimmed.indexOf(";");
      const command = (semicolon >= 0 ? trimmed.slice(0, semicolon) : trimmed).trim();
      if (!command) continue;
      const opcodeMatch = /^([GMT])\s*([-+]?\d+(?:\.\d+)?)/i.exec(command);
      if (!opcodeMatch) continue;
      const letter = opcodeMatch[1].toUpperCase();
      const code = Number(opcodeMatch[2]);

      if (letter === "T") {
        if (Number.isInteger(code) && code >= 0) state.toolIndex = code;
        continue;
      }
      if (letter === "M") {
        if (code === 82) state.eAbsolute = true;
        else if (code === 83) state.eAbsolute = false;
        continue;
      }
      if (letter !== "G") continue;
      if (code === 90) { state.xyzAbsolute = true; continue; }
      if (code === 91) { state.xyzAbsolute = false; continue; }
      if (code === 17) { state.plane = "XY"; continue; }
      if (code === 18) { state.plane = "XZ"; continue; }
      if (code === 19) { state.plane = "YZ"; continue; }

      const words = parseWords(command, lineCount);
      if (code === 92) {
        for (const [axis, key] of [["x", "X"], ["y", "Y"], ["z", "Z"]] as const) {
          const value = words.get(key);
          if (value !== undefined) state.position[axis] = value;
        }
        const e = words.get("E");
        if (e !== undefined) state.e = e;
        continue;
      }
      if (code !== 0 && code !== 1 && code !== 2 && code !== 3) continue;

      const start = cloneVec3(state.position);
      const end = cloneVec3(start);
      for (const [axis, key] of [["x", "X"], ["y", "Y"], ["z", "Z"]] as const) {
        const value = words.get(key);
        if (value !== undefined) end[axis] = state.xyzAbsolute ? value : start[axis] + value;
        if (!Number.isFinite(end[axis]) || Math.abs(end[axis]) > limits.maxCoordinateMm) {
          throw new SupportToolError("COORDINATE_LIMIT_EXCEEDED", `Coordinate ${key} is outside the supported range on line ${lineCount}.`);
        }
      }
      const eWord = words.get("E");
      const nextE = eWord === undefined ? state.e : (state.eAbsolute ? eWord : state.e + eWord);
      const deltaE = eWord === undefined ? 0 : nextE - state.e;
      const spatial = start.x !== end.x || start.y !== end.y || start.z !== end.z;
      let category = classifyRole(state.role);
      if (state.wipe) category = "wipe";
      else if (!spatial && deltaE < 0) category = "retract";
      else if (spatial && deltaE <= 0) category = "travel";
      const positiveEDeltaMm = spatial && deltaE > 0 ? deltaE : 0;

      if ((code === 2 || code === 3) && positiveEDeltaMm > 0 && state.plane !== "XY") {
        throw new SupportToolError("UNSUPPORTED_EXTRUSION_ARC", `Extrusion arcs in the ${state.plane} plane are unsupported (line ${lineCount}).`, { details: { line: lineCount, plane: state.plane } });
      }
      if ((code === 2 || code === 3) && positiveEDeltaMm > 0 && words.has("R")) {
        throw new SupportToolError("UNSUPPORTED_EXTRUSION_ARC", `R-form extrusion arcs are unsupported (line ${lineCount}).`, { details: { line: lineCount } });
      }

      let primitive: MotionPrimitive;
      if (code === 2 || code === 3) {
        if (state.plane !== "XY" || words.has("R")) {
          // Unsupported non-extruding arcs are retained as their endpoint travel chord.
          const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
          primitive = { kind: "line", start, end, role: state.role, category, layerIndex: state.layerIndex,
            z: state.zHeight ?? end.z, widthMm: state.widthMm, heightMm: state.heightMm,
            toolIndex: state.toolIndex, positiveEDeltaMm: 0, pathLengthMm: length,
            bounds: lineBounds(start, end), line: lineCount };
        } else {
          const i = words.get("I") ?? 0;
          const j = words.get("J") ?? 0;
          const p = words.get("P");
          if (p !== undefined && p !== 1) {
            throw new SupportToolError("UNSUPPORTED_EXTRUSION_ARC", `Only Bambu P1 full-circle arcs are supported (line ${lineCount}).`);
          }
          const fullCircle = p === 1;
          const arc = arcGeometry(start, end, i, j, code === 2, fullCircle, lineCount);
          primitive = { kind: "arc", start, end, center: arc.center, clockwise: code === 2, fullCircle,
            sweepRadians: arc.sweep, role: state.role, category, layerIndex: state.layerIndex,
            z: state.zHeight ?? end.z, widthMm: state.widthMm, heightMm: state.heightMm,
            toolIndex: state.toolIndex, positiveEDeltaMm, pathLengthMm: arc.length,
            bounds: arc.bounds, line: lineCount };
        }
      } else {
        const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
        primitive = { kind: "line", start, end, role: state.role, category, layerIndex: state.layerIndex,
          z: state.zHeight ?? end.z, widthMm: state.widthMm, heightMm: state.heightMm,
          toolIndex: state.toolIndex, positiveEDeltaMm, pathLengthMm: length,
          bounds: lineBounds(start, end), line: lineCount };
      }

      state.position = end;
      state.e = nextE;
      if (spatial || deltaE !== 0 || code === 2 || code === 3) await emit(primitive);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }

  if (!featureTagsPresent) {
    warnings.push({ code: "FEATURE_TAGS_MISSING", severity: "warning", message: "No FEATURE tags were found; support presence cannot be proven.", affects: ["role_classification", "support_present"] });
  }
  return {
    lineCount,
    motionCount,
    extrusionCount,
    layersSeen: layers.size,
    rolesSeen: [...roles].sort(),
    filamentMetadata: metadataFromHeaders(headers),
    slicerVersion,
    completeness: {
      complete: featureTagsPresent,
      featureTagsPresent,
      geometryComplete: true,
      metricsComplete: true,
    },
    warnings,
  };
}
