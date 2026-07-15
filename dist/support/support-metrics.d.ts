import type { Bounds3, FilamentMetadata, GcodeParseSummary, MotionPrimitive, SupportWarning } from "../3mf/gcode-types.js";
export interface MetricTotals {
    layer_count: number;
    segment_count: number;
    path_length_mm: number;
    commanded_filament_length_mm: number;
    commanded_volume_mm3: number | null;
    estimated_mass_g: number | null;
    centerline_bounds: Bounds3 | null;
    extrusion_envelope_bounds: Bounds3 | null;
}
export interface FilamentTotals extends MetricTotals {
    tool_index: number;
    filament_diameter_mm: number | null;
    density_g_cm3: number | null;
    filament_type: string | null;
    filament_color: string | null;
}
export declare class SupportMetricsCollector {
    private readonly body;
    private readonly transition;
    private readonly interfaceTotals;
    private readonly combined;
    private readonly perTool;
    accept(primitive: MotionPrimitive): void;
    finish(parse: GcodeParseSummary, supplementalMetadata?: FilamentMetadata[]): {
        support_present: boolean | null;
        support_body: MetricTotals;
        support_transition: MetricTotals;
        support_interface: MetricTotals;
        support_combined: MetricTotals;
        per_filament: FilamentTotals[];
        warnings: SupportWarning[];
    };
}
