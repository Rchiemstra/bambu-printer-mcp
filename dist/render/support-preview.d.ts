import type { PreviewView } from "./camera.js";
import type { RenderWorkerResult } from "./software-renderer.js";
export interface RenderPreviewInput {
    three_mf_path: string;
    plate_index?: number;
    timeout_ms?: number;
    view?: PreviewView;
    color_scheme?: "feature_type";
    show_model?: boolean;
    show_support?: boolean;
    show_support_interface?: boolean;
    show_travel?: boolean;
    layer_start?: number;
    layer_end?: number;
    width?: number;
    height?: number;
    background?: "solid" | "transparent";
    background_color?: string;
    save_path?: string;
    overwrite?: boolean;
}
export interface RenderPreviewResult extends RenderWorkerResult {
    summary: RenderWorkerResult["summary"] & {
        image_path: string | null;
        color_scheme: "feature_type";
        background: "solid" | "transparent";
    };
}
export declare function render3mfPreview(input: RenderPreviewInput, signal?: AbortSignal): Promise<RenderPreviewResult>;
