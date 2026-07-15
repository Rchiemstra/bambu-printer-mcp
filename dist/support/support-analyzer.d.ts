import { type ArchiveLimits } from "../3mf/gcode-3mf-reader.js";
import type { ParserLimits, SupportWarning } from "../3mf/gcode-types.js";
import { type SensitiveRegion, type MeshAnalysisResult } from "./mesh-analysis.js";
import { type FilamentTotals, type MetricTotals } from "./support-metrics.js";
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
    source: {
        path: string;
        size_bytes: number;
        modified_at: string;
    };
    plate: {
        index: number;
        archive_number: number;
        gcode_entry: string;
    };
    slicer_version: string | null;
    support_configuration: {
        enabled: boolean | null;
        type: string | null;
        source: string | null;
    };
    parser: {
        completeness: {
            complete: boolean;
            feature_tags_present: boolean;
            geometry_complete: boolean;
            metrics_complete: boolean;
        };
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
export declare function analyze3mfSupports(input: AnalyzeSupportsInput, options?: AnalyzeSupportsInternalOptions): Promise<AnalyzeSupportsResult>;
