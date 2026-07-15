import type { Bounds3, SupportWarning } from "../3mf/gcode-types.js";
import { createCamera, type PreviewView } from "./camera.js";
export interface RenderWorkerInput {
    three_mf_path: string;
    plate_index: number;
    deadline_ms: number;
    view: PreviewView;
    show_model: boolean;
    show_support: boolean;
    show_support_interface: boolean;
    show_travel: boolean;
    layer_start?: number;
    layer_end?: number;
    width: number;
    height: number;
    background: "solid" | "transparent";
    background_color: string;
}
export interface RenderWorkerResult {
    png: Buffer;
    summary: {
        camera: ReturnType<typeof createCamera>;
        fit_bounds: Bounds3;
        visible_roles: string[];
        dimensions: {
            width: number;
            height: number;
        };
        encoded_byte_count: number;
        support_summary: {
            support_present: boolean | null;
            layer_count: number;
            segment_count: number;
            path_length_mm: number;
        };
        parser: {
            complete: boolean;
            line_count: number;
            motion_count: number;
        };
        warnings: SupportWarning[];
    };
}
export declare function renderPreviewInWorker(input: RenderWorkerInput): Promise<RenderWorkerResult>;
