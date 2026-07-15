import fs from "node:fs/promises";
import { SecureGcode3mfReader, type ArchiveLimits } from "../3mf/gcode-3mf-reader.js";
import { parseGcodeStream } from "../3mf/gcode-parser.js";
import type { FilamentMetadata, ParserLimits, SupportWarning } from "../3mf/gcode-types.js";
import { MeshSupportAnalyzer, parse3mfTriangles, type SensitiveRegion, type MeshAnalysisResult } from "./mesh-analysis.js";
import { SupportMetricsCollector, type FilamentTotals, type MetricTotals } from "./support-metrics.js";
import { SupportToolError, throwIfCancelled } from "./support-error.js";

export interface AnalyzeSupportsInput {
  three_mf_path: string;
  plate_index?: number;
  timeout_ms?: number;
  mesh_analysis?: boolean;
  sensitive_regions?: SensitiveRegion[];
}

export interface AnalyzeSupportsInternalOptions {
  signal?: AbortSignal;
  now?: () => number;
  archiveLimits?: Partial<ArchiveLimits>;
  parserLimits?: Partial<ParserLimits>;
}

export interface AnalyzeSupportsResult {
  status: "ok";
  source: { path: string; size_bytes: number; modified_at: string };
  plate: { index: number; archive_number: number; gcode_entry: string };
  slicer_version: string | null;
  support_configuration: { enabled: boolean | null; type: string | null; source: string | null };
  parser: {
    completeness: { complete: boolean; feature_tags_present: boolean; geometry_complete: boolean; metrics_complete: boolean };
    line_count: number;
    motion_count: number;
    extrusion_count: number;
    roles_seen: string[];
  };
  support_present: boolean | null;
  support_body: MetricTotals;
  support_transition: MetricTotals;
  support_interface: MetricTotals;
  support_combined: MetricTotals;
  per_filament: FilamentTotals[];
  mesh_aware: boolean;
  mesh_triangle_count: number;
  contact_regions: MeshAnalysisResult["contact_regions"];
  contact_area_mm2: number | null;
  minimum_clearance_mm: number | null;
  blocked_openings: MeshAnalysisResult["blocked_openings"];
  metric_provenance: Record<string, "toolpath_exact" | "derived_from_commanded_e" | "estimated_from_density" | "mesh_heuristic" | "mesh_required">;
  warnings: SupportWarning[];
}

function validateInput(input: AnalyzeSupportsInput): { plateIndex: number; timeoutMs: number; meshAnalysis: boolean } {
  if (!input || typeof input.three_mf_path !== "string" || input.three_mf_path.trim().length === 0) {
    throw new SupportToolError("INVALID_INPUT", "three_mf_path is required.");
  }
  const plateIndex = input.plate_index ?? 0;
  if (!Number.isInteger(plateIndex) || plateIndex < 0) throw new SupportToolError("INVALID_PLATE_INDEX", "plate_index must be a non-negative integer.");
  const timeoutMs = input.timeout_ms ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SupportToolError("INVALID_TIMEOUT", "timeout_ms must be an integer from 1 to 120000.");
  if (input.sensitive_regions !== undefined && !Array.isArray(input.sensitive_regions)) throw new SupportToolError("INVALID_SENSITIVE_REGIONS", "sensitive_regions must be an array.");
  return { plateIndex, timeoutMs, meshAnalysis: input.mesh_analysis ?? true };
}

function parseJson(buffer: Buffer | null, label: string, warnings: SupportWarning[]): Record<string, any> | null {
  if (!buffer) return null;
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected object");
    return parsed;
  } catch (error) {
    warnings.push({ code: "MALFORMED_3MF_METADATA", severity: "warning", message: `${label} is malformed JSON: ${error instanceof Error ? error.message : String(error)}.`, affects: ["support_configuration", "filament_metadata", "plate_membership"] });
    return null;
  }
}

function firstSetting(config: Record<string, any> | null, key: string): unknown {
  if (!config) return undefined;
  const value = config[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseBooleanSetting(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === false || value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s*;\s*/).filter(Boolean);
  return [];
}

function filamentMetadata(config: Record<string, any> | null): FilamentMetadata[] {
  const diameters = stringArray(config?.filament_diameter);
  const densities = stringArray(config?.filament_density);
  const types = stringArray(config?.filament_type);
  const colors = stringArray(config?.filament_colour ?? config?.filament_color);
  const count = Math.max(diameters.length, densities.length, types.length, colors.length);
  return Array.from({ length: count }, (_, toolIndex) => ({
    toolIndex,
    diameterMm: Number(diameters[toolIndex]) > 0 ? Number(diameters[toolIndex]) : null,
    densityGcm3: Number(densities[toolIndex]) > 0 ? Number(densities[toolIndex]) : null,
    type: types[toolIndex] ?? null,
    color: colors[toolIndex] ?? null,
  }));
}

function plateObjectIds(plate: Record<string, any> | null): Set<number> | undefined {
  const items = Array.isArray(plate?.bbox_objects) ? plate!.bbox_objects : [];
  const ids = new Set<number>();
  for (const item of items) {
    const id = Number(item?.id ?? item?.object_id ?? item?.objectid);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids.size > 0 ? ids : undefined;
}

function deduplicateWarnings(warnings: SupportWarning[]): SupportWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${warning.line ?? ""}|${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function analyze3mfSupports(
  input: AnalyzeSupportsInput,
  options: AnalyzeSupportsInternalOptions = {}
): Promise<AnalyzeSupportsResult> {
  const validated = validateInput(input);
  const now = options.now ?? Date.now;
  const deadlineMs = now() + validated.timeoutMs;
  const reader = await SecureGcode3mfReader.open(input.three_mf_path, validated.plateIndex, {
    signal: options.signal,
    deadlineMs,
    limits: options.archiveLimits,
  });
  throwIfCancelled(options.signal, deadlineMs);
  const warnings: SupportWarning[] = [];
  const [projectBuffer, plateBuffer] = await Promise.all([
    reader.readOptionalEntryBuffer("Metadata/project_settings.config", options.signal, deadlineMs),
    reader.readOptionalEntryBuffer(`Metadata/plate_${reader.plateNumber}.json`, options.signal, deadlineMs),
  ]);
  const project = parseJson(projectBuffer, "Project settings", warnings);
  const plate = parseJson(plateBuffer, "Plate metadata", warnings);
  const enabled = parseBooleanSetting(firstSetting(project, "enable_support"));
  const supportTypeRaw = firstSetting(project, "support_type");
  const supportType = supportTypeRaw === undefined || supportTypeRaw === null ? null : String(supportTypeRaw);

  let mesh: MeshSupportAnalyzer | null = null;
  let meshDisabledResult: MeshAnalysisResult = {
    mesh_aware: false,
    mesh_triangle_count: 0,
    contact_regions: null,
    contact_area_mm2: null,
    minimum_clearance_mm: null,
    blocked_openings: null,
    mesh_warnings: [{ code: "MESH_ANALYSIS_DISABLED", severity: "warning", message: "Mesh analysis was disabled; contact and accessibility metrics require a mesh pass.", affects: ["contact_regions", "contact_area_mm2", "minimum_clearance_mm", "blocked_openings"] }],
  };
  if (validated.meshAnalysis) {
    const model = await reader.readEntryBuffer("3D/3dmodel.model", options.signal, deadlineMs);
    const triangles = await parse3mfTriangles(model, plateObjectIds(plate));
    mesh = new MeshSupportAnalyzer(triangles, input.sensitive_regions ?? []);
    if (triangles.length === 0) {
      meshDisabledResult = {
        mesh_aware: true, mesh_triangle_count: 0, contact_regions: [], contact_area_mm2: 0,
        minimum_clearance_mm: null, blocked_openings: [],
        mesh_warnings: [{ code: "EMPTY_3MF_MESH", severity: "warning", message: "The selected plate contains no mesh triangles; contact and clearance results are limited.", affects: ["minimum_clearance_mm"] }],
      };
    }
  }

  const collector = new SupportMetricsCollector();
  const stream = await reader.openGcodeStream(options.signal, deadlineMs);
  const parse = await parseGcodeStream(stream, {
    signal: options.signal,
    deadlineMs,
    limits: options.parserLimits,
    onPrimitive: (primitive) => { collector.accept(primitive); mesh?.accept(primitive); },
  });
  const metrics = collector.finish(parse, filamentMetadata(project));
  const completedMesh = mesh?.finish();
  const meshResult = completedMesh ? (completedMesh.mesh_triangle_count === 0 ? meshDisabledResult : completedMesh) : meshDisabledResult;
  const stat = await fs.stat(reader.sourcePath);
  const allWarnings = deduplicateWarnings([
    ...warnings,
    ...metrics.warnings,
    ...meshResult.mesh_warnings,
  ]);
  return {
    status: "ok",
    source: { path: reader.sourcePath, size_bytes: stat.size, modified_at: stat.mtime.toISOString() },
    plate: { index: reader.plateIndex, archive_number: reader.plateNumber, gcode_entry: reader.gcodeEntryName },
    slicer_version: parse.slicerVersion,
    support_configuration: { enabled, type: supportType, source: project ? "Metadata/project_settings.config" : null },
    parser: {
      completeness: { complete: parse.completeness.complete, feature_tags_present: parse.completeness.featureTagsPresent, geometry_complete: parse.completeness.geometryComplete, metrics_complete: parse.completeness.metricsComplete },
      line_count: parse.lineCount,
      motion_count: parse.motionCount,
      extrusion_count: parse.extrusionCount,
      roles_seen: parse.rolesSeen,
    },
    support_present: metrics.support_present,
    support_body: metrics.support_body,
    support_transition: metrics.support_transition,
    support_interface: metrics.support_interface,
    support_combined: metrics.support_combined,
    per_filament: metrics.per_filament,
    mesh_aware: meshResult.mesh_aware,
    mesh_triangle_count: meshResult.mesh_triangle_count,
    contact_regions: meshResult.contact_regions,
    contact_area_mm2: meshResult.contact_area_mm2,
    minimum_clearance_mm: meshResult.minimum_clearance_mm,
    blocked_openings: meshResult.blocked_openings,
    metric_provenance: {
      path_length_mm: "toolpath_exact",
      commanded_filament_length_mm: "toolpath_exact",
      commanded_volume_mm3: "derived_from_commanded_e",
      estimated_mass_g: "estimated_from_density",
      contact_regions: meshResult.mesh_aware ? "mesh_heuristic" : "mesh_required",
      contact_area_mm2: meshResult.mesh_aware ? "mesh_heuristic" : "mesh_required",
      minimum_clearance_mm: meshResult.mesh_aware ? "mesh_heuristic" : "mesh_required",
      blocked_openings: meshResult.mesh_aware ? "mesh_heuristic" : "mesh_required",
    },
    warnings: allWarnings,
  };
}
