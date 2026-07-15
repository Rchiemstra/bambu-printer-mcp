import type {
  Bounds3,
  FilamentMetadata,
  GcodeParseSummary,
  MotionPrimitive,
  SupportWarning,
} from "../3mf/gcode-types.js";
import { isSupportCategory } from "../3mf/gcode-roles.js";

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

type MutableTotals = {
  layers: Set<number>;
  segmentCount: number;
  pathLengthMm: number;
  filamentLengthMm: number;
  centerlineBounds: Bounds3 | null;
  envelopeBounds: Bounds3 | null;
  byToolE: Map<number, number>;
};

function emptyMutable(): MutableTotals {
  return { layers: new Set(), segmentCount: 0, pathLengthMm: 0, filamentLengthMm: 0,
    centerlineBounds: null, envelopeBounds: null, byToolE: new Map() };
}

function includeBounds(target: Bounds3 | null, incoming: Bounds3): Bounds3 {
  if (!target) return {
    min: { ...incoming.min },
    max: { ...incoming.max },
  };
  target.min.x = Math.min(target.min.x, incoming.min.x);
  target.min.y = Math.min(target.min.y, incoming.min.y);
  target.min.z = Math.min(target.min.z, incoming.min.z);
  target.max.x = Math.max(target.max.x, incoming.max.x);
  target.max.y = Math.max(target.max.y, incoming.max.y);
  target.max.z = Math.max(target.max.z, incoming.max.z);
  return target;
}

function envelopeBounds(primitive: MotionPrimitive): Bounds3 | null {
  if (!(primitive.widthMm !== null && primitive.widthMm > 0)) return null;
  const radius = primitive.widthMm / 2;
  const height = primitive.heightMm !== null && primitive.heightMm > 0 ? primitive.heightMm : 0;
  return {
    min: { x: primitive.bounds.min.x - radius, y: primitive.bounds.min.y - radius, z: primitive.bounds.min.z - height / 2 },
    max: { x: primitive.bounds.max.x + radius, y: primitive.bounds.max.y + radius, z: primitive.bounds.max.z + height / 2 },
  };
}

function addPrimitive(target: MutableTotals, primitive: MotionPrimitive): void {
  target.segmentCount += 1;
  target.pathLengthMm += primitive.pathLengthMm;
  target.filamentLengthMm += primitive.positiveEDeltaMm;
  if (primitive.layerIndex !== null) target.layers.add(primitive.layerIndex);
  target.centerlineBounds = includeBounds(target.centerlineBounds, primitive.bounds);
  const envelope = envelopeBounds(primitive);
  if (envelope) target.envelopeBounds = includeBounds(target.envelopeBounds, envelope);
  const tool = primitive.toolIndex ?? 0;
  target.byToolE.set(tool, (target.byToolE.get(tool) ?? 0) + primitive.positiveEDeltaMm);
}

function round(value: number): number {
  return Number(value.toFixed(9));
}

function calculateMaterial(
  byToolE: Map<number, number>,
  metadata: Map<number, FilamentMetadata>,
  warnings: SupportWarning[],
  warningPrefix: string
): { volume: number | null; mass: number | null } {
  let volume = 0;
  let mass = 0;
  let volumeKnown = true;
  let massKnown = true;
  for (const [tool, e] of byToolE) {
    const filament = metadata.get(tool);
    if (!filament?.diameterMm) {
      volumeKnown = false;
      massKnown = false;
      warnings.push({ code: "FILAMENT_DIAMETER_MISSING", severity: "warning", message: `${warningPrefix}: filament diameter is missing for tool ${tool}.`, affects: ["commanded_volume_mm3", "estimated_mass_g"] });
      continue;
    }
    const toolVolume = e * Math.PI * Math.pow(filament.diameterMm / 2, 2);
    volume += toolVolume;
    if (!filament.densityGcm3) {
      massKnown = false;
      warnings.push({ code: "FILAMENT_DENSITY_MISSING", severity: "warning", message: `${warningPrefix}: filament density is missing for tool ${tool}.`, affects: ["estimated_mass_g"] });
    } else {
      mass += toolVolume * filament.densityGcm3 / 1000;
    }
  }
  return { volume: volumeKnown ? round(volume) : null, mass: volumeKnown && massKnown ? round(mass) : null };
}

function finalize(target: MutableTotals, metadata: Map<number, FilamentMetadata>, warnings: SupportWarning[], prefix: string): MetricTotals {
  const material = calculateMaterial(target.byToolE, metadata, warnings, prefix);
  return {
    layer_count: target.layers.size,
    segment_count: target.segmentCount,
    path_length_mm: round(target.pathLengthMm),
    commanded_filament_length_mm: round(target.filamentLengthMm),
    commanded_volume_mm3: material.volume,
    estimated_mass_g: material.mass,
    centerline_bounds: target.centerlineBounds,
    extrusion_envelope_bounds: target.envelopeBounds,
  };
}

export class SupportMetricsCollector {
  private readonly body = emptyMutable();
  private readonly transition = emptyMutable();
  private readonly interfaceTotals = emptyMutable();
  private readonly combined = emptyMutable();
  private readonly perTool = new Map<number, MutableTotals>();

  accept(primitive: MotionPrimitive): void {
    if (primitive.positiveEDeltaMm <= 0 || !isSupportCategory(primitive.category)) return;
    if (primitive.category === "support_body") addPrimitive(this.body, primitive);
    else if (primitive.category === "support_transition") addPrimitive(this.transition, primitive);
    else addPrimitive(this.interfaceTotals, primitive);
    addPrimitive(this.combined, primitive);
    const tool = primitive.toolIndex ?? 0;
    let perTool = this.perTool.get(tool);
    if (!perTool) { perTool = emptyMutable(); this.perTool.set(tool, perTool); }
    addPrimitive(perTool, primitive);
  }

  finish(parse: GcodeParseSummary, supplementalMetadata: FilamentMetadata[] = []): {
    support_present: boolean | null;
    support_body: MetricTotals;
    support_transition: MetricTotals;
    support_interface: MetricTotals;
    support_combined: MetricTotals;
    per_filament: FilamentTotals[];
    warnings: SupportWarning[];
  } {
    const metadata = new Map<number, FilamentMetadata>();
    for (const item of supplementalMetadata) metadata.set(item.toolIndex, item);
    for (const item of parse.filamentMetadata) {
      const previous = metadata.get(item.toolIndex);
      metadata.set(item.toolIndex, {
        toolIndex: item.toolIndex,
        diameterMm: item.diameterMm ?? previous?.diameterMm ?? null,
        densityGcm3: item.densityGcm3 ?? previous?.densityGcm3 ?? null,
        type: item.type ?? previous?.type ?? null,
        color: item.color ?? previous?.color ?? null,
      });
    }
    const warnings = [...parse.warnings];
    const body = finalize(this.body, metadata, warnings, "Support body");
    const transition = finalize(this.transition, metadata, warnings, "Support transition");
    const supportInterface = finalize(this.interfaceTotals, metadata, warnings, "Support interface");
    const combined = finalize(this.combined, metadata, warnings, "Combined support");
    const perFilament: FilamentTotals[] = [];
    for (const [tool, totals] of [...this.perTool].sort(([a], [b]) => a - b)) {
      const filament = metadata.get(tool) ?? { toolIndex: tool, diameterMm: null, densityGcm3: null, type: null, color: null };
      const metric = finalize(totals, metadata, warnings, `Support tool ${tool}`);
      perFilament.push({ ...metric, tool_index: tool, filament_diameter_mm: filament.diameterMm,
        density_g_cm3: filament.densityGcm3, filament_type: filament.type, filament_color: filament.color });
    }
    return {
      support_present: parse.completeness.featureTagsPresent ? combined.segment_count > 0 : null,
      support_body: body,
      support_transition: transition,
      support_interface: supportInterface,
      support_combined: combined,
      per_filament: perFilament,
      warnings,
    };
  }
}
