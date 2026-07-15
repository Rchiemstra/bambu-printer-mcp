export type Vec2 = {
    x: number;
    y: number;
};
export type Vec3 = {
    x: number;
    y: number;
    z: number;
};
export type ToolpathCategory = "support_body" | "support_transition" | "support_interface" | "model" | "adhesion" | "prime_tower" | "flush" | "custom" | "unknown" | "travel" | "retract" | "wipe";
export type WarningSeverity = "warning" | "error";
export interface SupportWarning {
    code: string;
    severity: WarningSeverity;
    message: string;
    line?: number;
    affects?: string[];
}
export interface Bounds3 {
    min: Vec3;
    max: Vec3;
}
export interface MotionPrimitive {
    kind: "line" | "arc";
    start: Vec3;
    end: Vec3;
    center?: Vec2;
    clockwise?: boolean;
    fullCircle?: boolean;
    sweepRadians?: number;
    role: string | null;
    category: ToolpathCategory;
    layerIndex: number | null;
    z: number;
    widthMm: number | null;
    heightMm: number | null;
    toolIndex: number | null;
    positiveEDeltaMm: number;
    pathLengthMm: number;
    bounds: Bounds3;
    line: number;
}
export interface FilamentMetadata {
    toolIndex: number;
    diameterMm: number | null;
    densityGcm3: number | null;
    type: string | null;
    color: string | null;
}
export interface ParserCompleteness {
    complete: boolean;
    featureTagsPresent: boolean;
    geometryComplete: boolean;
    metricsComplete: boolean;
}
export interface GcodeParseSummary {
    lineCount: number;
    motionCount: number;
    extrusionCount: number;
    layersSeen: number;
    rolesSeen: string[];
    filamentMetadata: FilamentMetadata[];
    slicerVersion: string | null;
    completeness: ParserCompleteness;
    warnings: SupportWarning[];
}
export interface ParserLimits {
    maxGcodeBytes: number;
    maxLines: number;
    maxMotions: number;
    maxLineBytes: number;
    maxCoordinateMm: number;
}
export declare const DEFAULT_PARSER_LIMITS: ParserLimits;
export interface ParseOptions {
    signal?: AbortSignal;
    deadlineMs?: number;
    limits?: Partial<ParserLimits>;
    onPrimitive?: (primitive: MotionPrimitive) => void | Promise<void>;
}
