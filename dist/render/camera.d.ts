import type { Bounds3, Vec3 } from "../3mf/gcode-types.js";
export type PreviewView = "isometric" | "front" | "rear" | "left" | "right" | "top" | "bottom";
export interface CameraProjection {
    projection: "orthographic";
    direction: Vec3;
    up: Vec3;
    right: Vec3;
    target: Vec3;
    fit_bounds: Bounds3;
    margin_fraction: number;
    pixels_per_mm: number;
}
export declare function createCamera(view: PreviewView, bounds: Bounds3, width: number, height: number): CameraProjection;
export declare function projectPoint(point: Vec3, camera: CameraProjection, width: number, height: number): {
    x: number;
    y: number;
    depth: number;
};
