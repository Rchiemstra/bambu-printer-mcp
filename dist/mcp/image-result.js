export function createPreviewMcpResult(result) {
    const text = JSON.stringify(result.summary, null, 2);
    return { content: [{ type: "text", text }, { type: "image", data: result.png.toString("base64"), mimeType: "image/png" }], structuredContent: result.summary };
}
