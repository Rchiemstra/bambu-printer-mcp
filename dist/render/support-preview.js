import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { SupportToolError } from "../support/support-error.js";
function normalizeInput(input) {
    if (!input || typeof input.three_mf_path !== "string" || !input.three_mf_path.trim())
        throw new SupportToolError("INVALID_INPUT", "three_mf_path is required.");
    const plate = input.plate_index ?? 0, timeout = input.timeout_ms ?? 60000, width = input.width ?? 1200, height = input.height ?? 900;
    if (!Number.isInteger(plate) || plate < 0)
        throw new SupportToolError("INVALID_PLATE_INDEX", "plate_index must be a non-negative integer.");
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
        throw new SupportToolError("INVALID_TIMEOUT", "timeout_ms must be an integer from 1 to 120000.");
    if (!Number.isInteger(width) || width < 64 || width > 2048 || !Number.isInteger(height) || height < 64 || height > 2048 || width * height > 4000000)
        throw new SupportToolError("INVALID_IMAGE_DIMENSIONS", "width and height must be 64..2048 and no more than 4 megapixels combined.");
    const views = new Set(["isometric", "front", "rear", "left", "right", "top", "bottom"]);
    const view = input.view ?? "isometric";
    if (!views.has(view))
        throw new SupportToolError("INVALID_VIEW", "Unsupported preview view.");
    if (input.color_scheme !== undefined && input.color_scheme !== "feature_type")
        throw new SupportToolError("INVALID_COLOR_SCHEME", "Only feature_type is supported.");
    if (input.layer_start !== undefined && (!Number.isInteger(input.layer_start) || input.layer_start < 0))
        throw new SupportToolError("INVALID_LAYER_RANGE", "layer_start must be a non-negative integer.");
    if (input.layer_end !== undefined && (!Number.isInteger(input.layer_end) || input.layer_end < 0))
        throw new SupportToolError("INVALID_LAYER_RANGE", "layer_end must be a non-negative integer.");
    if (input.layer_start !== undefined && input.layer_end !== undefined && input.layer_start > input.layer_end)
        throw new SupportToolError("INVALID_LAYER_RANGE", "layer_start cannot exceed layer_end.");
    return { three_mf_path: input.three_mf_path, plate_index: plate, deadline_ms: Date.now() + timeout, view, width, height, show_model: input.show_model ?? true, show_support: input.show_support ?? true, show_support_interface: input.show_support_interface ?? true, show_travel: input.show_travel ?? false, layer_start: input.layer_start, layer_end: input.layer_end, background: input.background ?? "solid", background_color: input.background_color ?? "#FFFFFF" };
}
async function runWorker(input, signal) {
    if (signal?.aborted)
        throw new SupportToolError("CANCELLED", "Preview rendering was cancelled.");
    const worker = new Worker(new URL("./render-worker.js", import.meta.url), { workerData: input });
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => { if (settled)
            return; settled = true; signal?.removeEventListener("abort", abort); clearTimeout(timer); callback(); };
        const abort = () => { void worker.terminate().finally(() => finish(() => reject(new SupportToolError("CANCELLED", "Preview rendering was cancelled.")))); };
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => { void worker.terminate().finally(() => finish(() => reject(new SupportToolError("TIMEOUT", "Preview rendering exceeded its deadline.", { retryable: true })))); }, Math.max(1, input.deadline_ms - Date.now()));
        worker.once("message", (message) => finish(() => message?.ok ? resolve({ png: Buffer.from(message.png), summary: message.summary }) : reject(new SupportToolError(message?.error?.code ?? "RENDER_FAILED", message?.error?.message ?? "Preview worker failed.", { retryable: Boolean(message?.error?.retryable), details: message?.error?.details }))));
        worker.once("error", (error) => finish(() => reject(new SupportToolError("RENDER_WORKER_FAILED", error.message, { cause: error }))));
        worker.once("exit", (code) => { if (!settled && code !== 0)
            finish(() => reject(new SupportToolError("RENDER_WORKER_FAILED", `Preview worker exited with code ${code}.`))); });
    });
}
async function saveAtomically(data, destination, overwrite) {
    const resolved = path.resolve(destination), parent = path.dirname(resolved);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory())
        throw new SupportToolError("INVALID_SAVE_PATH", "save_path parent must be a directory.");
    try {
        const leaf = await fs.lstat(resolved);
        if (leaf.isSymbolicLink())
            throw new SupportToolError("UNSAFE_SAVE_PATH", "save_path cannot be a symlink.");
        if (!overwrite)
            throw new SupportToolError("SAVE_PATH_EXISTS", "save_path exists and overwrite is false.");
        if (!leaf.isFile())
            throw new SupportToolError("INVALID_SAVE_PATH", "save_path must be a file destination.");
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    const temporary = path.join(parent, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
    let handle = null;
    try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        try {
            const leaf = await fs.lstat(resolved);
            if (leaf.isSymbolicLink())
                throw new SupportToolError("UNSAFE_SAVE_PATH", "save_path became a symlink during rendering.");
            if (!overwrite)
                throw new SupportToolError("SAVE_PATH_EXISTS", "save_path was created during rendering.");
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        if (overwrite)
            await fs.rename(temporary, resolved);
        else {
            await fs.link(temporary, resolved);
            await fs.unlink(temporary);
        }
        return resolved;
    }
    catch (error) {
        if (handle)
            await handle.close().catch(() => undefined);
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
    }
}
export async function render3mfPreview(input, signal) {
    const normalized = normalizeInput(input);
    const result = await runWorker(normalized, signal);
    const imagePath = input.save_path ? await saveAtomically(result.png, input.save_path, input.overwrite ?? false) : null;
    return { png: result.png, summary: { ...result.summary, image_path: imagePath, color_scheme: "feature_type", background: normalized.background } };
}
