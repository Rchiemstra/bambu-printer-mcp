import type { RenderPreviewResult } from "../render/support-preview.js";
export declare function createPreviewMcpResult(result: RenderPreviewResult): {
    content: Array<{
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: "image/png";
    }>;
    structuredContent: RenderPreviewResult["summary"];
};
