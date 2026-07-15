import { parseStringPromise } from "xml2js";
import { isSupportCategory } from "../3mf/gcode-roles.js";
import { SupportToolError } from "./support-error.js";
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function multiply(a, b) {
    const a4 = [[a[0], a[1], a[2], 0], [a[3], a[4], a[5], 0], [a[6], a[7], a[8], 0], [a[9], a[10], a[11], 1]];
    const b4 = [[b[0], b[1], b[2], 0], [b[3], b[4], b[5], 0], [b[6], b[7], b[8], 0], [b[9], b[10], b[11], 1]];
    const out = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
            for (let k = 0; k < 4; k++)
                out[r][c] += a4[r][k] * b4[k][c];
    return [out[0][0], out[0][1], out[0][2], out[1][0], out[1][1], out[1][2], out[2][0], out[2][1], out[2][2], out[3][0], out[3][1], out[3][2]];
}
function parseTransform(raw) {
    if (!raw)
        return [...IDENTITY];
    const values = raw.trim().split(/\s+/).map(Number);
    if (values.length !== 12 || values.some((value) => !Number.isFinite(value))) {
        throw new SupportToolError("MALFORMED_3MF_TRANSFORM", "A 3MF transform must contain 12 finite numbers.");
    }
    return values;
}
function transform(point, matrix, scale) {
    return {
        x: (point.x * matrix[0] + point.y * matrix[3] + point.z * matrix[6] + matrix[9]) * scale,
        y: (point.x * matrix[1] + point.y * matrix[4] + point.z * matrix[7] + matrix[10]) * scale,
        z: (point.x * matrix[2] + point.y * matrix[5] + point.z * matrix[8] + matrix[11]) * scale,
    };
}
function unitScale(unit) {
    const scales = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
    return scales[(unit ?? "millimeter").toLowerCase()] ?? 1;
}
function children(node, suffix) {
    if (!node || typeof node !== "object")
        return [];
    const key = Object.keys(node).find((candidate) => candidate === suffix || candidate.endsWith(`:${suffix}`));
    const value = key ? node[key] : undefined;
    return Array.isArray(value) ? value : value ? [value] : [];
}
function triangle(a, b, c) {
    return {
        a, b, c,
        min: { x: Math.min(a.x, b.x, c.x), y: Math.min(a.y, b.y, c.y), z: Math.min(a.z, b.z, c.z) },
        max: { x: Math.max(a.x, b.x, c.x), y: Math.max(a.y, b.y, c.y), z: Math.max(a.z, b.z, c.z) },
    };
}
export async function parse3mfTriangles(modelXml, plateObjectIds) {
    let parsed;
    try {
        parsed = await parseStringPromise(modelXml.toString("utf8"), { explicitArray: true, attrkey: "$" });
    }
    catch (error) {
        throw new SupportToolError("MALFORMED_3MF_MODEL", "Unable to parse 3MF model XML.", { cause: error });
    }
    const root = parsed.model ?? parsed[Object.keys(parsed)[0]];
    const scale = unitScale(root?.$?.unit);
    const resources = children(root, "resources")[0];
    const objects = new Map();
    for (const object of children(resources, "object")) {
        const id = Number(object?.$?.id);
        if (Number.isInteger(id))
            objects.set(id, object);
    }
    const output = [];
    const visit = (objectId, matrix, stack) => {
        if (stack.has(objectId))
            throw new SupportToolError("CYCLIC_3MF_COMPONENT", `3MF component cycle includes object ${objectId}.`);
        const object = objects.get(objectId);
        if (!object)
            throw new SupportToolError("MISSING_3MF_OBJECT", `3MF references missing object ${objectId}.`);
        const nextStack = new Set(stack).add(objectId);
        const mesh = children(object, "mesh")[0];
        if (mesh) {
            const verticesNode = children(mesh, "vertices")[0];
            const vertices = children(verticesNode, "vertex").map((vertex) => {
                const point = { x: Number(vertex?.$?.x), y: Number(vertex?.$?.y), z: Number(vertex?.$?.z) };
                if (![point.x, point.y, point.z].every(Number.isFinite))
                    throw new SupportToolError("MALFORMED_3MF_MESH", "3MF vertex contains a non-finite coordinate.");
                return transform(point, matrix, scale);
            });
            const trianglesNode = children(mesh, "triangles")[0];
            for (const item of children(trianglesNode, "triangle")) {
                const indices = [Number(item?.$?.v1), Number(item?.$?.v2), Number(item?.$?.v3)];
                if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
                    throw new SupportToolError("MALFORMED_3MF_MESH", "3MF triangle has an invalid vertex index.");
                }
                output.push(triangle(vertices[indices[0]], vertices[indices[1]], vertices[indices[2]]));
            }
        }
        const components = children(object, "components")[0];
        for (const component of children(components, "component")) {
            const childId = Number(component?.$?.objectid);
            visit(childId, multiply(parseTransform(component?.$?.transform), matrix), nextStack);
        }
    };
    const build = children(root, "build")[0];
    for (const item of children(build, "item")) {
        const id = Number(item?.$?.objectid);
        if (plateObjectIds && plateObjectIds.size > 0 && !plateObjectIds.has(id))
            continue;
        visit(id, parseTransform(item?.$?.transform), new Set());
    }
    return output;
}
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function mul(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
// Closest-point algorithm from Real-Time Collision Detection, expressed without allocations beyond small vectors.
function pointTriangleDistance(p, t) {
    const ab = sub(t.b, t.a), ac = sub(t.c, t.a), ap = sub(p, t.a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0)
        return distance(p, t.a);
    const bp = sub(p, t.b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3)
        return distance(p, t.b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return distance(p, add(t.a, mul(ab, v)));
    }
    const cp = sub(p, t.c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6)
        return distance(p, t.c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return distance(p, add(t.a, mul(ac, w)));
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return distance(p, add(t.b, mul(sub(t.c, t.b), w)));
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    return distance(p, add(t.a, add(mul(ab, v), mul(ac, w))));
}
function regionBounds(region) {
    if (region.kind === "box") {
        const size = region.size;
        if (!size || [size.x, size.y, size.z].some((value) => !Number.isFinite(value) || value <= 0))
            throw new SupportToolError("INVALID_SENSITIVE_REGION", `Box annotation ${region.id} requires a positive size.`);
        return { min: { x: region.center.x - size.x / 2, y: region.center.y - size.y / 2, z: region.center.z - size.z / 2 }, max: { x: region.center.x + size.x / 2, y: region.center.y + size.y / 2, z: region.center.z + size.z / 2 } };
    }
    const radius = region.radius_mm, height = region.height_mm;
    if (!(radius && radius > 0 && height && height > 0))
        throw new SupportToolError("INVALID_SENSITIVE_REGION", `Cylinder annotation ${region.id} requires positive radius_mm and height_mm.`);
    return { min: { x: region.center.x - radius, y: region.center.y - radius, z: region.center.z - height / 2 }, max: { x: region.center.x + radius, y: region.center.y + radius, z: region.center.z + height / 2 } };
}
function intersects(a, b, expand = 0) { return a.min.x - expand <= b.max.x && a.max.x + expand >= b.min.x && a.min.y - expand <= b.max.y && a.max.y + expand >= b.min.y && a.min.z - expand <= b.max.z && a.max.z + expand >= b.min.z; }
export class MeshSupportAnalyzer {
    constructor(triangles, annotations = []) {
        this.triangles = triangles;
        this.annotations = annotations;
        this.grid = new Map();
        this.globalTriangles = [];
        this.gridSizeMm = 10;
        this.contacts = new Map();
        this.blocked = new Map();
        this.minimumClearance = Number.POSITIVE_INFINITY;
        this.annotationBounds = annotations.map((region) => ({ region, bounds: regionBounds(region) }));
        let references = 0;
        for (let index = 0; index < triangles.length; index += 1) {
            const tri = triangles[index];
            const minX = Math.floor(tri.min.x / this.gridSizeMm), maxX = Math.floor(tri.max.x / this.gridSizeMm);
            const minY = Math.floor(tri.min.y / this.gridSizeMm), maxY = Math.floor(tri.max.y / this.gridSizeMm);
            const minZ = Math.floor(tri.min.z / this.gridSizeMm), maxZ = Math.floor(tri.max.z / this.gridSizeMm);
            const cells = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
            if (cells > 4096 || references + cells > 2000000) {
                this.globalTriangles.push(index);
                continue;
            }
            for (let x = minX; x <= maxX; x++)
                for (let y = minY; y <= maxY; y++)
                    for (let z = minZ; z <= maxZ; z++) {
                        const key = `${x},${y},${z}`, bucket = this.grid.get(key);
                        if (bucket)
                            bucket.push(index);
                        else
                            this.grid.set(key, [index]);
                        references += 1;
                    }
        }
    }
    nearby(point) {
        const cx = Math.floor(point.x / this.gridSizeMm), cy = Math.floor(point.y / this.gridSizeMm), cz = Math.floor(point.z / this.gridSizeMm);
        const indices = new Set(this.globalTriangles);
        for (let x = cx - 1; x <= cx + 1; x++)
            for (let y = cy - 1; y <= cy + 1; y++)
                for (let z = cz - 1; z <= cz + 1; z++)
                    for (const index of this.grid.get(`${x},${y},${z}`) ?? [])
                        indices.add(index);
        return [...indices].map((index) => this.triangles[index]);
    }
    accept(primitive) {
        if (primitive.positiveEDeltaMm <= 0 || !isSupportCategory(primitive.category))
            return;
        const radius = Math.max(0, (primitive.widthMm ?? 0.4) / 2);
        for (const item of this.annotationBounds)
            if (intersects(primitive.bounds, item.bounds, radius))
                this.blocked.set(item.region.id, (this.blocked.get(item.region.id) ?? 0) + 1);
        if (this.triangles.length === 0)
            return;
        const samples = [primitive.start, { x: (primitive.start.x + primitive.end.x) / 2, y: (primitive.start.y + primitive.end.y) / 2, z: (primitive.start.z + primitive.end.z) / 2 }, primitive.end];
        let closest = Number.POSITIVE_INFINITY;
        let contactPoint = null;
        for (const sample of samples) {
            for (const tri of this.nearby(sample)) {
                if (sample.x < tri.min.x - 5 || sample.x > tri.max.x + 5 || sample.y < tri.min.y - 5 || sample.y > tri.max.y + 5 || sample.z < tri.min.z - 5 || sample.z > tri.max.z + 5)
                    continue;
                const d = pointTriangleDistance(sample, tri);
                if (d < closest) {
                    closest = d;
                    contactPoint = sample;
                }
            }
        }
        if (Number.isFinite(closest))
            this.minimumClearance = Math.min(this.minimumClearance, Math.max(0, closest - radius));
        if (contactPoint && closest <= radius + 0.2) {
            const key = `${Math.round(contactPoint.x / 2)},${Math.round(contactPoint.y / 2)},${Math.round(contactPoint.z / 2)}`;
            const old = this.contacts.get(key) ?? { sum: { x: 0, y: 0, z: 0 }, count: 0, area: 0 };
            old.sum = add(old.sum, contactPoint);
            old.count += 1;
            if (primitive.category === "support_interface")
                old.area += primitive.pathLengthMm * (primitive.widthMm ?? 0.4);
            this.contacts.set(key, old);
        }
    }
    finish() {
        const contact_regions = [...this.contacts.entries()].map(([id, value]) => ({ id: `contact-${id}`, center: mul(value.sum, 1 / value.count), estimated_area_mm2: Number(value.area.toFixed(6)), sample_count: value.count, confidence: (value.count >= 3 ? "medium" : "low") }));
        const blocked_openings = this.annotations.map((region) => ({ annotation_id: region.id, semantic: region.semantic ?? null, support_segment_count: this.blocked.get(region.id) ?? 0, confidence: "medium", heuristic: "support_envelope_intersects_annotation" })).filter((item) => item.support_segment_count > 0);
        return { mesh_aware: true, mesh_triangle_count: this.triangles.length, contact_regions, contact_area_mm2: Number(contact_regions.reduce((sum, item) => sum + item.estimated_area_mm2, 0).toFixed(6)), minimum_clearance_mm: Number.isFinite(this.minimumClearance) ? Number(this.minimumClearance.toFixed(6)) : null, blocked_openings, mesh_warnings: [{ code: "MESH_ANALYSIS_HEURISTIC", severity: "warning", message: "Contacts sample support centerlines near triangles; clearance and annotated opening results are geometric heuristics, not manufacturing guarantees.", affects: ["contact_regions", "contact_area_mm2", "minimum_clearance_mm", "blocked_openings"] }] };
    }
}
