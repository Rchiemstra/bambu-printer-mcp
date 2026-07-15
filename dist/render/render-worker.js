import { parentPort, workerData } from "node:worker_threads";
import { renderPreviewInWorker } from "./software-renderer.js";
import { asSupportToolError } from "../support/support-error.js";
if (!parentPort)
    throw new Error("render-worker must run in a worker thread");
try {
    const result = await renderPreviewInWorker(workerData);
    parentPort.postMessage({ ok: true, png: result.png, summary: result.summary });
}
catch (error) {
    const structured = asSupportToolError(error);
    parentPort.postMessage({ ok: false, error: { code: structured.code, message: structured.message, retryable: structured.retryable, details: structured.details } });
}
