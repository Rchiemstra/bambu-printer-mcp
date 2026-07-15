import type { MotionPrimitive, Vec3 } from "../3mf/gcode-types.js";
type Triangle = {
    a: Vec3;
    b: Vec3;
    c: Vec3;
    min: Vec3;
    max: Vec3;
};
export interface SensitiveRegion {
    id: string;
    semantic?: string;
    kind: "box" | "cylinder";
    center: Vec3;
    size?: Vec3;
    radius_mm?: number;
    height_mm?: number;
}
export interface ContactRegion {
    id: string;
    center: Vec3;
    estimated_area_mm2: number;
    sample_count: number;
    confidence: "low" | "medium";
}
export interface BlockedOpening {
    annotation_id: string;
    semantic: string | null;
    support_segment_count: number;
    confidence: "medium";
    heuristic: "support_envelope_intersects_annotation";
}
export interface MeshAnalysisResult {
    mesh_aware: boolean;
    mesh_triangle_count: number;
    contact_regions: ContactRegion[] | null;
    contact_area_mm2: number | null;
    minimum_clearance_mm: number | null;
    blocked_openings: BlockedOpening[] | null;
    mesh_warnings: Array<{
        code: string;
        severity: "warning";
        message: string;
        affects?: string[];
    }>;
}
export declare function parse3mfTriangles(modelXml: Buffer, plateObjectIds?: Set<number>): Promise<Triangle[]>;
export declare class MeshSupportAnalyzer {
    private readonly triangles;
    private readonly annotations;
    private readonly grid;
    private readonly globalTriangles;
    private readonly gridSizeMm;
    private readonly contacts;
    private readonly blocked;
    private minimumClearance;
    private readonly annotationBounds;
    constructor(triangles: Triangle[], annotations?: SensitiveRegion[]);
    private nearby;
    accept(primitive: MotionPrimitive): void;
    finish(): MeshAnalysisResult;
}
export {};
