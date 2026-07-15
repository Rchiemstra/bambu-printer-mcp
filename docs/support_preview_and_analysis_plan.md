# Sliced-Support Preview and Analysis Architecture Plan

> Implementation status (2026-07-15): the TypeScript secure-reader, support-analysis, deterministic-rendering, MCP image, and mesh-aware phases described here are implemented. The optional native Bambu Studio backend and orientation comparison remain intentionally unimplemented. Mesh fields that this original MVP plan specified as `null` are populated by the completed mesh-aware phase when `mesh_analysis` is enabled; see [`SUPPORT_ANALYSIS.md`](./SUPPORT_ANALYSIS.md) for the current public behavior.

## 1. Executive summary

This document proposes a hybrid architecture for inspecting support toolpaths in sliced Bambu 3MF projects:

- The MVP is a portable TypeScript implementation that securely streams the selected plate G-code, calculates deterministic support statistics, and renders a semantic software preview.
- A separately maintained, patched Bambu Studio renderer may be added later when matching-version visual fidelity justifies its build, licensing, and headless-rendering costs.
- `compare_support_orientations` is explicitly outside the MVP. It is a future offline slicer-orchestration tool, not part of support analysis or preview rendering.

The TypeScript result will be semantically accurate rather than pixel-identical to Bambu Studio. It will classify toolpaths using the feature markers emitted by the slicer, compute commanded extrusion metrics, and produce an orthographic PNG without initializing MQTT, FTPS, a printer object, or any native GUI/OpenGL runtime.

The upstream findings in this plan are pinned to Bambu Studio commit [`ba049f6a2e08c3b6033660bb84da80c08722974b`](https://github.com/bambulab/BambuStudio/tree/ba049f6a2e08c3b6033660bb84da80c08722974b). Local slice behavior was verified with Bambu Studio `02.05.00.66` on Windows. The pinned upstream commit identifies itself as build `02.08.01.55`, so compatibility must be treated as behavior-based rather than inferred from a single product version.

This task is architectural only. It introduces no production feature implementation.

## 2. Current-state analysis

The server already has three useful but separate capabilities:

1. It can read Bambu 3MF project metadata.
2. It can invoke Bambu Studio or OrcaSlicer to create sliced 3MF output.
3. It can return JSON tool results and optionally `structuredContent`.

It does not currently parse sliced toolpaths into motion primitives, calculate support-only metrics, render those primitives, or return MCP image content. Existing archive access uses JSZip and buffers complete inputs. That is adequate for the current metadata operations but is not the desired foundation for adversarial or very large sliced projects.

The architectural boundary should therefore be explicit: existing metadata code may remain untouched initially, while the new support-analysis subsystem gets its own streaming archive reader and G-code parser. This prevents feature work from expanding the memory and attack surface of existing JSZip paths.

## 3. Relevant `bambu-printer-mcp` findings

- `parse3MF()` and related functions in `src/3mf_parser.ts` call `fs.readFile()` and `JSZip.loadAsync()`. They inspect project/model settings such as `enable_support`, `support_type`, and support angles; they do not reconstruct toolpath geometry.
- `BambuImplementation.resolveProjectFileMetadata()` in `src/printers/bambu.ts` already resolves `Metadata/plate_<n>.gcode`, reads headers, and checks associated metadata. It nevertheless buffers the complete archive and then the complete selected G-code.
- `STLManipulator.sliceSTL()` in `src/stl/stl-manipulator.ts` already produces sliced 3MF output through Bambu Studio/Orca CLI. Analysis should accept that output but must not inherit slicer or printer initialization as a side effect.
- `BambuPrinterMCPServer.setupToolHandlers()` in `src/index.ts` returns serialized JSON in text content and can also return `structuredContent`. The future tools should follow that compatibility pattern.
- `camera_snapshot` returns JPEG base64 inside JSON. That is useful precedent for binary handling but is not MCP `ImageContent` and should not be copied for preview output.
- `package-lock.json` resolves `@modelcontextprotocol/sdk` `1.29.0`. Its image content shape is `{ type: "image", data: <base64>, mimeType: "image/png" }`. The protocol permits a result containing both text and image content, plus structured content. Client display remains client-dependent; protocol validity alone does not guarantee inline rendering. See the [MCP schema](https://modelcontextprotocol.io/specification/2025-11-25/schema).

### Repository verification baseline

At the time of this investigation:

- `npm run build` completed with zero TypeScript errors.
- On Windows, `node --test tests/behavior.test.mjs` reported 40 passing tests, 2 failures, and 1 skip.
- The two failures were pre-existing fake-slicer execution cases: `slice_with_template prefers named template settings over BAMBU_SLICER_PROFILE default` and `template_name resolves by source type for slicer profiles versus 3MF sources`.

Future work must record this baseline honestly. It must not claim that the full behavior suite was clean unless those two Windows failures have also been resolved. Tests use compiled `dist/index.js`, so the build must precede behavior testing.

## 4. Relevant Bambu Studio findings

The upstream execution path is sufficient to explain how semantic toolpaths can be reconstructed without reusing the GUI renderer:

- `GCode::extrude_path()` writes role, line-width, and layer-height tags before extrusion. See [`GCode.cpp`](https://github.com/bambulab/BambuStudio/blob/ba049f6a2e08c3b6033660bb84da80c08722974b/src/libslic3r/GCode.cpp#L7322-L7345).
- `GCodeProcessor::process_tags()` restores feature role and geometry state. `process_G1()` processes linear motion, and `process_G2_G3()` processes arcs. See [`GCodeProcessor.cpp`](https://github.com/bambulab/BambuStudio/blob/ba049f6a2e08c3b6033660bb84da80c08722974b/src/libslic3r/GCode/GCodeProcessor.cpp#L3245-L3315).
- `GCodeViewer` delegates display to OpenGL renderers with role visibility controls.
- Existing `--export-png` behavior renders model/plate thumbnails rather than sliced toolpaths. See [`BambuStudio.cpp`](https://github.com/bambulab/BambuStudio/blob/ba049f6a2e08c3b6033660bb84da80c08722974b/src/BambuStudio.cpp#L8181-L8221).
- `export_toolpaths_to_obj()` exports extrusion geometry only. In the advanced renderer, semantic feature role is encoded through texture coordinates and a color texture, not preserved as straightforward semantic OBJ groups. Travel paths are absent.
- The legacy off-screen path is calibration-specific and restricted to early layers. The advanced calibration-thumbnail implementation is empty. Neither path is a ready-made general headless preview API.

The role enum and stable role strings are defined in [`ExtrusionEntity.hpp`](https://github.com/bambulab/BambuStudio/blob/ba049f6a2e08c3b6033660bb84da80c08722974b/src/libslic3r/ExtrusionEntity.hpp#L44-L69) and [`ExtrusionEntity.cpp`](https://github.com/bambulab/BambuStudio/blob/ba049f6a2e08c3b6033660bb84da80c08722974b/src/libslic3r/ExtrusionEntity.cpp#L613-L688). These pinned definitions should be copied into tests as behavior fixtures, not imported as a runtime dependency.

## 5. Verified G-code feature markers

Disposable normal-support and tree-support projects were sliced locally with Bambu Studio `02.05.00.66`. The exact relevant markers were:

```gcode
; FEATURE: Support
; LINE_WIDTH: 0.5
; LAYER_HEIGHT: 0.28
; CHANGE_LAYER
; Z_HEIGHT: 4.2
```

The normal-support slice produced `Support`, `Support transition`, and `Support interface`. The tree-support slice used the same `Support` and `Support interface` role names. Consequently, tree versus normal is project configuration metadata; it cannot be inferred from extrusion role names.

Locally verified model roles include:

- `Inner wall`, `Outer wall`, and `Overhang wall`
- `Sparse infill`, `Internal solid infill`, and `Floating vertical shell`
- `Top surface`, `Bottom surface`, `Bridge`, `Gap infill`, and `Custom`

The pinned upstream role table additionally defines `Support ironing`, `Ironing`, `Skirt`, `Brim`, `Prime tower`, `Flush`, and `Multiple`. Parsers must accept known upstream roles that are absent from small local samples, and must preserve unknown roles rather than coercing them into model or support.

Phase 0 should add only small, sanitized excerpts derived from disposable slices. Complete generated projects may contain machine, profile, path, or other local data and should not be committed as fixtures.

## 6. Architecture options

### Option A — TypeScript parser and renderer

Parse the selected G-code in a streaming TypeScript pipeline and draw directly into RGBA and depth buffers. This provides exact role classification when valid tags exist, exact commanded path/E metrics for supported motion forms, and an approximate but deterministic view. It has strong Windows, Linux, and headless behavior, avoids native code execution, and is readily fuzzed and unit-tested. Maintenance centers on parser state, role aliases, and controlled compatibility extensions.

### Option B — patched Bambu Studio

Add a native command or library entry point that loads processed G-code and invokes the viewer renderer off-screen. This offers the best chance of matching the corresponding Bambu Studio release, but headless OpenGL/wxWidgets behavior is fragile, startup and memory costs are high, and binary packaging must track Studio versions and drivers. Bambu Studio is AGPL-3.0; modified distribution or network use requires legal review. Its native parser and graphics stack must also be isolated from arbitrary files.

### Option C — existing OBJ export

Patch a native entry point to invoke the current extrusion OBJ exporter, then decode geometry plus texture-based role data in the MCP server. Geometry could be accurate, but the route still loads the GUI/native renderer, excludes travel paths, loses simple semantic grouping, and duplicates large geometry. It inherits the platform, licensing, and input-safety costs of Option B while adding an intermediate representation.

### Option D — hybrid

Ship Option A as the always-available implementation. Define an internal renderer boundary that could later call a separately distributed Option B backend. Deterministic statistics remain in TypeScript regardless of renderer selection. This isolates native and AGPL concerns and permits incremental adoption without reducing MVP portability.

## 7. Comparison matrix

| Option | Feasibility and accuracy | Platforms/headless | Complexity and maintenance | Performance/testability | Licensing and security |
|---|---|---|---|---|---|
| A. TypeScript parser and renderer | High; exact role classification and commanded metrics, approximate rather than pixel-identical rendering | Strong Windows/Linux/headless support | Medium; role aliases and parser state require maintenance | Streaming, deterministic, readily unit-tested | GPL-2.0-compatible with MIT dependencies; no code execution |
| B. Patched Bambu Studio | Medium-low; highest matching-version fidelity | Windows/Linux possible, but headless OpenGL/wx setup is fragile | Very high build, packaging, GPU, and version burden | High startup/memory cost; driver-sensitive tests | Bambu Studio is AGPL-3.0; modified distribution/network use needs legal review and native parser isolation |
| C. Existing OBJ export | Medium only after loading the GUI renderer; geometry is accurate but semantic roles are indirect and travel is missing | Same limitations as B | High because it still needs a patched GUI/native entry point plus OBJ/texture decoding | Duplicates geometry and is harder to test deterministically | Same AGPL/native-input concerns as B |
| D. Hybrid | High incrementally; portable MVP with optional high-fidelity rendering | Portable fallback always available | Medium for MVP, high only for optional backend | Best balance; statistics stay deterministic | Keeps AGPL component optional and separately bounded |

### Comparison details and failure modes

Accuracy is version-sensitive for every option. A TypeScript parser can track marker and motion semantics across releases but will not reproduce Bambu's exact tube mesh, antialiasing, lighting, or camera. A native backend can match one Studio build more closely, but compatibility is weaker when its binary and the input-producing slicer diverge. The plan must therefore report detected slicer version and parser completeness rather than advertise universal compatibility.

Option A fails safely when it encounters unsupported extrusion arcs, missing role tags, malformed state, limits, or timeouts. Options B and C introduce harder-to-contain failures: graphics initialization, missing display servers, driver defects, ABI mismatches, excessive native allocations, and native parser crashes. The hybrid fallback must never silently substitute an analysis with different metric semantics.

On Windows and Linux, TypeScript software rendering needs no display server. Native Studio builds require platform-specific packaging and may require virtual-display or off-screen graphics configuration on Linux. GPU/driver output also undermines byte-identical golden tests.

For memory, streaming analysis remains aggregate-only. Software preview memory is dominated by the RGBA buffer, depth buffer, ZIP/parser state, and bounded rasterization scratch space. OBJ export and native viewing retain or duplicate substantial per-move/per-vertex geometry. For arbitrary files, all paths need strict size and time limits; native paths add a larger unsafe-code surface. These differences make Option D the best overall choice even if Option B is eventually offered for opt-in fidelity.

## 8. Recommended architecture

Adopt the hybrid design, with only the TypeScript backend in the MVP:

```text
3MF file
  -> secure lazy ZIP reader
  -> selected plate G-code stream
  -> stateful semantic motion parser
       -> aggregate support analyzer -> JSON/text result
       -> pass 1 bounds/summary
       -> pass 2 worker rasterizer -> PNG + JSON/text result
```

Analysis and preview share archive validation, G-code state semantics, role classification, warnings, completeness reporting, and metric formulas. They must not share mutable parser instances: preview reopens the selected ZIP entry for its second streaming pass.

An eventual native renderer is an optional adapter behind a separately distributed boundary. It does not replace the TypeScript analyzer, become an MVP dependency, or change the public metric definitions.

## 9. Proposed MCP tool schemas

### `analyze_3mf_supports`

Input:

```ts
{
  three_mf_path: string;          // required
  plate_index?: number;           // integer, zero-based, default 0
  timeout_ms?: number;            // integer, default 30000, max 120000
}
```

The result contains serialized JSON as the first text item and the same object as `structuredContent` when enabled. Its stable top-level fields should include:

- source path/identity, selected plate, detected slicer/version, and detected support configuration
- `support_present: boolean | null`
- parser completeness plus structured warning/error records
- separate `support_body`, `support_transition`, `support_interface`, and `support_combined` totals
- support layer count, segment count, path length, commanded filament length, commanded material volume, estimated mass, centerline bounds, and estimated extrusion-envelope bounds
- per-filament totals for multi-material support
- `mesh_aware: false`
- `contact_regions`, `contact_area_mm2`, `minimum_clearance_mm`, and `blocked_openings`, all `null` in the MVP
- per-metric provenance values such as `toolpath_exact`, `derived_from_commanded_e`, `estimated_from_density`, and `mesh_required`

`support_present` is `false` only when a complete, role-tagged parse proves there were no support-role extrusion moves. It is `null` when feature tags are absent or classification is otherwise insufficient. Mesh-dependent fields must be `null`, never empty arrays or zeroes that imply the mesh was examined and nothing was found.

### `render_3mf_preview`

Input:

```ts
{
  three_mf_path: string;
  plate_index?: number;           // zero-based, default 0
  timeout_ms?: number;            // default 60000, max 120000
  view?: "isometric" | "front" | "rear" | "left" | "right" | "top" | "bottom"; // default isometric
  color_scheme?: "feature_type"; // default and only MVP value
  show_model?: boolean;           // default true
  show_support?: boolean;         // default true
  show_support_interface?: boolean; // default true
  show_travel?: boolean;          // default false
  layer_start?: number;           // inclusive
  layer_end?: number;             // inclusive
  width?: number;                 // default 1200, range 64..2048
  height?: number;                // default 900, range 64..2048; width*height <= 4,000,000
  background?: "solid" | "transparent"; // default solid
  background_color?: string;      // validated color, default white
  save_path?: string;
  overwrite?: boolean;            // default false
}
```

Result content order:

1. Text fallback containing the serialized structured summary.
2. MCP image content: `{ type: "image", data: png.toString("base64"), mimeType: "image/png" }`.

The summary reports camera projection, direction, up vector, fit bounds, visible roles, output dimensions, encoded byte count, support summary, warnings, and `image_path: string | null`. Image base64 must not be duplicated in text or `structuredContent`.

Without `save_path`, the implementation retains no temporary image file. With `save_path`, it validates the destination, rejects a symlink leaf, honors `overwrite: false`, writes a sibling temporary file, atomically renames it, and cleans partial files on failure. Clients that do not display image content still get useful text and may request an explicit save path.

### Deferred orientation comparison

Do not expose `compare_support_orientations` in the MVP. A future implementation would orchestrate multiple offline slicer runs and compare outputs using the same analyzer. Because slicing creates printer-specific G-code, that future tool must require and validate `BAMBU_MODEL`. In contrast, `analyze_3mf_supports` and `render_3mf_preview` read already-sliced files and must neither require `BAMBU_MODEL` nor contact a printer.

## 10. Internal data model

Keep the event model small and stream-oriented. Suggested types are:

```ts
type ToolpathCategory =
  | "support_body" | "support_transition" | "support_interface"
  | "model" | "adhesion" | "prime_tower" | "flush"
  | "custom" | "unknown" | "travel" | "retract" | "wipe";

interface MotionPrimitive {
  kind: "line" | "arc";
  start: Vec3;
  end: Vec3;
  center?: Vec2;
  clockwise?: boolean;
  fullCircle?: boolean;
  role: string | null;
  category: ToolpathCategory;
  layerIndex: number | null;
  z: number;
  widthMm: number | null;
  heightMm: number | null;
  toolIndex: number | null;
  positiveEDeltaMm: number;
  pathLengthMm: number;
}
```

The parser yields primitives to callbacks/iterators; analysis updates aggregates and discards each primitive. The renderer projects and rasterizes each visible primitive without building an array proportional to movement count. Warnings include a code, severity, location/line where available, message, and affected completeness dimensions.

Role categories are:

- Support body: `Support`
- Support transition: `Support transition`
- Support interface: `Support interface`, `Support ironing`
- Model: walls, infill, surfaces, bridge, gap fill, and model ironing
- Separate categories: adhesion (`Skirt`, `Brim`), prime tower, flush, custom, unknown, travel, retract, and wipe

`Multiple` should be retained as an unknown/mixed semantic role unless a future verified rule can split it without guessing.

## 11. 3MF extraction design

Add a new reader based on `yauzl` lazy entry streams rather than extending JSZip use. `yauzl` and its typings are MIT-licensed and support central-directory inspection plus streamed entry access.

Reader sequence:

1. Open the source without shell execution, verify that it is a regular file, enforce the archive byte limit, and validate ZIP/3MF signatures.
2. Iterate entries lazily and normalize names using ZIP `/` semantics. Reject NULs, absolute paths, drive/UNC forms, backslashes, `.`/`..` traversal, empty normalized names, duplicate normalized paths, encryption flags, and symlink file attributes.
3. Enforce entry count, individual declared size, total declared expansion, and compression-ratio limits before opening content.
4. Resolve exactly `Metadata/plate_<plate_index + 1>.gcode` after converting the public zero-based index to the archive's one-based naming. Do not use suffix matching.
5. Read only bounded metadata needed for slicer/support configuration and filament properties. Treat malformed JSON/XML as structured warnings or errors according to whether the field is required.
6. If `plate_<n>.gcode.md5` exists, validate its syntax and compare it to the selected uncompressed stream. A mismatch is a hard integrity error.
7. Expose a factory that reopens the selected entry for the renderer's second pass. Do not retain a full decompressed G-code buffer.

ZIP metadata is untrusted. Declared sizes and ratios are early rejection signals, not substitutes for counting actual streamed bytes. Both counts must be enforced.

## 12. G-code parsing design

The parser is a line-oriented state machine. It tracks:

- current X/Y/Z and E coordinates
- `G90`/`G91` XYZ absolute/relative mode
- `M82`/`M83` E absolute/relative mode independently
- `G92`, including `G92 E0`
- current feature role, layer index, Z height, line width, and layer height
- active tool/filament and relevant filament metadata
- wipe, prime-tower, flush, and custom-code regions

Only finite numeric values are accepted. Coordinates must remain within the configured bounds. Comments are parsed only for verified tags; other text is inert. Unknown commands must never be executed or passed to a shell.

For `G0`/`G1`, a spatial move with positive effective E delta is extrusion. Negative E is retract; positive E without spatial motion is unretract/prime and is not a path extrusion. Zero-E spatial movement is travel. The parser excludes retractions, unretractions, and non-spatial E moves from commanded toolpath filament totals.

For `G2`/`G3`, MVP support is restricted to XY-plane arcs with I/J center offsets, including Bambu `P1` full circles. Arc sweep and planar bounds are analytic. Path length is helical when Z changes:

```text
planar_arc_length = radius * absolute_sweep_radians
path_length = sqrt(planar_arc_length^2 + delta_z^2)
```

Cardinal angles that lie within the directed sweep extend the analytic XY bounds; Z bounds use the endpoints because helical Z changes monotonically. Tessellation is used only for rasterization. Extruding arcs in unsupported planes or R-form extrusion arcs produce a structured completeness error rather than a silent chord approximation. Unknown non-motion commands remain inert.

Missing role markers do not make parsing unsafe, but they make semantic support conclusions incomplete. A truncated line, excessive line, invalid numeric motion, impossible arc, limit breach, or incomplete selected file records an explicit error and prevents false exactness.

## 13. Support-analysis design

Each positive-E spatial support primitive updates its role-specific and combined aggregates:

- segment count
- unique parsed layer set
- centerline AABB
- estimated extrusion-envelope AABB, expanding the centerline by half the known line width in XY and accounting for extrusion height in Z
- path length
- positive commanded filament length
- volume and mass, grouped by active filament/tool

Metric formulas:

```text
line_path_mm = sqrt(delta_x^2 + delta_y^2 + delta_z^2)
filament_area_mm2 = pi * (filament_diameter_mm / 2)^2
volume_mm3 = positive_delta_e_mm * filament_area_mm2
mass_g = volume_mm3 * density_g_cm3 / 1000
```

Do not reapply flow multipliers: slicer flow is already represented in commanded E. If diameter or density is absent/invalid, dependent totals are `null` and carry a warning instead of using an undocumented default. Path length and commanded E remain available.

The analyzer counts each parsed layer containing at least one support extrusion once. Normal/tree style is reported from configuration metadata, independently from actual support presence. Toolpath role classification is `toolpath_exact` only when the relevant marker stream is present and complete.

MVP does not load object meshes. It therefore cannot truthfully identify model contact regions, support-to-model clearance, blocked openings, bearing seats, screw holes, or functional surfaces. Those fields remain explicitly `null` with `mesh_required` provenance.

## 14. Rendering design

Use a custom deterministic TypeScript rasterizer with `pngjs`. Do not introduce Three.js WebGL, a browser runtime, Cairo/canvas native bindings, SVG conversion, or native OpenGL for the MVP.

Rendering uses two streamed passes:

1. Parse the selected G-code and compute full metrics plus bounds for primitives visible under role and inclusive layer filters.
2. Reopen and parse the same entry, project visible primitives, and rasterize them directly into fixed-size RGBA and depth buffers.

Use orthographic projection with a 5% fit margin. Camera-from-target directions are:

| View | Direction |
|---|---|
| isometric | `(1, -1, 1)` |
| front | `(0, -1, 0)` |
| rear | `(0, 1, 0)` |
| left | `(-1, 0, 0)` |
| right | `(1, 0, 0)` |
| top | `(0, 0, 1)` |
| bottom | `(0, 0, -1)` |

Derive a stable up vector per view, including a non-collinear choice for top/bottom, and report it in results. Fit extrusion-envelope bounds where available, falling back to centerlines with a warning. Empty visible selections should return a structured error rather than a misleading blank success image.

Rasterize thick projected line/arc segments with analytic pixel-distance coverage, deterministic edge coverage, and a depth buffer. Arc tessellation tolerance must be defined in projected-pixel terms and capped to prevent unbounded subdivision. Fixed `pngjs` filter/compression settings, integer color conversion, stable iteration order, and no platform fonts are required for byte-identical output.

Use a stable local feature palette: bright green support body, intermediate green transition, darker green interface, categorical model colors, and grey travel. This is inspired by the semantic distinctions in Studio but is a local API contract, not a promise to reproduce Studio colors exactly.

Run rasterization and PNG encoding in a worker thread so CPU-heavy work does not block MCP transport. Cancellation terminates the worker. The worker receives bounded configuration and a validated source descriptor; it does not receive printer credentials or initialize application services.

## 15. MCP image-response design

The handler should accept the SDK request-handler `AbortSignal` and propagate it through archive reads, parsing, worker execution, and atomic file output. The result remains useful to image-capable and text-only clients:

```ts
{
  content: [
    { type: "text", text: JSON.stringify(summary) },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" }
  ],
  structuredContent: summary
}
```

Do not include base64 inside `summary`. Validate encoded PNG size before constructing the response. A client-display smoke test should be performed in every available client during Phase 0, but failure to display inline does not change the standards-compliant response. The explicit `save_path` path is the fallback.

Structured errors should use stable codes such as `ARCHIVE_LIMIT_EXCEEDED`, `UNSAFE_ZIP_ENTRY`, `PLATE_GCODE_NOT_FOUND`, `GCODE_CHECKSUM_MISMATCH`, `UNSUPPORTED_EXTRUSION_ARC`, `PARSER_INCOMPLETE`, `RENDER_LIMIT_EXCEEDED`, `TIMEOUT`, and `CANCELLED`.

## 16. Security constraints

Default hard limits:

| Resource | Limit |
|---|---:|
| Archive file | 256 MiB |
| ZIP entries | 4,096 |
| Total declared expansion | 1 GiB |
| Selected G-code | 512 MiB |
| Each metadata entry | 16 MiB |
| Compression ratio | 100:1 |
| G-code lines | 10,000,000 |
| Motion commands | 5,000,000 |
| One line | 1 MiB |
| Coordinate magnitude | 1,000,000 mm |
| Analyze timeout | 30 seconds |
| Render timeout | 60 seconds |
| Caller timeout maximum | 120 seconds |
| Encoded PNG | 8 MiB |

Additional rules:

- Reject non-finite values and unsafe normalized ZIP paths, duplicate paths, encrypted entries, and symlink entries.
- Treat `three_mf_path` and `save_path` as local filesystem inputs, never commands. Do not spawn a slicer for analysis/rendering.
- Reject a symlink destination leaf. Recheck the destination immediately before atomic rename and avoid following a newly introduced leaf where platform APIs permit.
- Use an exclusive temporary sibling, flush/close it, then rename atomically. Clean it on any failure or cancellation.
- Enforce both explicit deadlines and the MCP `AbortSignal`; periodically check during parsing/raster loops, destroy streams, and terminate workers.
- Never interpret or execute custom G-code, macros, paths, URLs, or embedded scripts.
- Do not initialize or invoke printer, MQTT, FTPS, camera, or print methods.

For an optional native backend, run the renderer in a separate process with resource limits, a minimal environment, no network/printer secrets, and a disposable working directory. Native input isolation and AGPL obligations require dedicated review before distribution.

## 17. Performance strategy

Planning targets, to be validated with Windows and Linux benchmarks:

| Uncompressed selected G-code | Analysis target | Preview target |
|---|---:|---:|
| Under 10 MiB | under 1 second | under 3 seconds |
| 10–100 MiB | roughly 1–8 seconds | roughly 3–20 seconds |
| Over 100 MiB | likely 10–60 seconds, subject to limits | likely 10–60 seconds, subject to limits |

Analysis retains aggregate maps, bounds, warnings, and a set/bitmap of support layer identifiers, not movements. Preview memory is principally `width * height * 4` RGBA bytes plus the depth buffer, ZIP/parser buffers, and bounded scanline/tessellation scratch state. At the 4-megapixel limit, buffer sizes must be documented and measured, but remain independent of G-code movement count.

Read streams with backpressure. Avoid per-line regular-expression allocation in hot paths where a simple scanner suffices. Yield/check cancellation at bounded byte or motion intervals. Benchmarks must include compressed archive overhead, checksum validation, two-pass reopen, transparent PNGs, high-entropy images, and output that approaches the 8 MiB encoded cap.

## 18. Implementation phases

### Phase 0 — preserve source verification

- Add sanitized, small normal/tree role excerpts derived from disposable slices.
- Verify role behavior against at least local Bambu Studio `02.05.00.66` and a then-current upstream release.
- Record pinned source commit/version and compatibility deviations.
- Smoke-test mixed MCP text/image results in available clients while retaining the explicit-save fallback.

### Phase 1 — reader, parser, metrics, and analysis tool

- Implement the secure lazy archive reader.
- Implement stateful linear/arc parsing, role classification, completeness, and provenance.
- Implement aggregate support statistics and `analyze_3mf_supports`.
- Prove by integration test that no printer communication is initialized.

### Phase 2 — deterministic preview

- Implement projection, software rasterization, depth handling, and fixed PNG encoding.
- Add the render worker, cancellation, save-path security, and mixed MCP content helper.
- Expose `render_3mf_preview` and establish cross-platform goldens.

### Phase 3 — mesh-aware analysis

- Parse 3MF units, object/component meshes, transforms, and plate membership.
- Build a triangle spatial index and compare swept support envelopes with model meshes.
- Cluster contact regions, estimate interface footprints, and introduce clearance/cavity heuristics with confidence.
- Accept explicit sensitive-region annotations for functional geometry.

### Phase 4 — optional Studio renderer

- Prototype and legally review a separately distributed, sandboxed Bambu Studio renderer.
- Keep deterministic TypeScript statistics and the software fallback available.
- Version the adapter protocol and report backend/source version in every result.

### Future — orientation comparison

Use isolated slicer processes to create candidates, then feed them to the analyzer. Require `BAMBU_MODEL`; keep slicing separate from printer communication and require explicit resource limits for candidate counts and concurrent slicers.

## 19. File-by-file change plan

No files in this list are changed by this architecture-only task. Eventual implementation should be grouped as follows:

- `src/3mf/gcode-3mf-reader.ts`: archive/path validation, limits, exact plate resolution, metadata reads, checksum, and reopenable G-code streams.
- `src/3mf/gcode-types.ts`: parser state, motion events, roles, completeness, warning, bounds, and provenance types.
- `src/3mf/gcode-roles.ts`: pinned role aliases and category mapping.
- `src/3mf/gcode-parser.ts`: tag scanner, positioning/extrusion state, lines, arcs, and callbacks/iterators.
- `src/support/support-metrics.ts`: exact formulas, per-role/per-filament aggregates, bounds, and null propagation.
- `src/support/support-analyzer.ts`: archive metadata plus parser/metrics orchestration and public result assembly.
- `src/render/camera.ts`: view vectors, stable up vectors, orthographic fitting, and projection metadata.
- `src/render/software-renderer.ts`: deterministic thick primitives, depth, color, backgrounds, and layer/role filtering.
- `src/render/render-worker.ts` and worker message types: bounded CPU work, cancellation, and PNG encoding.
- `src/mcp/image-result.ts`: mixed text/image/structured results, encoded-size enforcement, and secure optional save behavior.
- `src/index.ts`: tool schemas, handler routing, `AbortSignal` propagation, deadlines, structured errors, and assurance that analysis routes do not resolve a printer.
- `package.json` and `package-lock.json`: add `yauzl`, `@types/yauzl`, and `pngjs` (and typings if required), with license review and pinned compatible versions.
- `tests/support-*.test.mjs` or equivalent TypeScript test sources: parser, metrics, archives, rendering, integration, cancellation, and no-printer proofs.
- `tests/fixtures/support/`: compact sanitized G-code excerpts and essential golden PNGs only; programmatically wrap archives in tests.

Avoid modifying existing JSZip metadata paths until a separately scoped migration is justified. A narrow new subsystem reduces regression risk.

## 20. Test plan

### Parser tests

- `G90`/`G91` combined with `M82`/`M83`, including independent mode changes
- `G92 E0` and other axis resets
- retract, unretract/prime, zero-E travel, and positive-E spatial extrusion
- `G0`/`G1`, I/J clockwise/counterclockwise arcs, helical arcs, and `P1` full circles
- analytic arc bounds and rendering-only tessellation
- variable layer heights and layer/Z markers
- malformed/non-finite numbers, overlong lines, incomplete files, missing tags, unknown roles/commands
- structured rejection of unsupported planes and R-form extrusion arcs

### Classification and metric tests

- complete no-support toolpath versus missing-role indeterminate support
- normal and tree configuration with the shared support roles
- body, transition, interface, and support ironing totals
- prime tower, adhesion, flush, travel, wipe, and custom exclusion
- multi-extruder support with diameter/density present and missing
- commanded E volume/mass formulas, provenance, unique layer counts, and both bounds types

### Archive tests

- path traversal, absolute/drive/UNC names, backslashes, NULs, and duplicate normalized names
- symlink entries, encrypted entries, excessive entry/size/ratio declarations, and actual streamed overruns
- compression bombs and cancellation during inflation
- missing, wrong, or ambiguous plate entries
- checksum match/mismatch and malformed checksum
- malformed or oversized JSON/XML metadata

Malicious archives should be generated during tests, not committed.

### Renderer tests

- all seven camera views and deterministic camera metadata
- model/support/interface/travel toggles and inclusive layer filters
- transparent and solid backgrounds plus validated colors
- empty-visible-selection behavior
- PNG signature, dimensions, color type, encoded-size limit, and byte-identical output on Windows and Linux
- depth ordering, thick-line coverage, arc tessellation caps, and bounds fitting

### MCP integration tests

- text fallback first, matching `structuredContent`, image second, and no duplicated base64
- explicit save path, overwrite policy, symlink rejection, atomic success, and cleanup on failure
- caller timeout, `AbortSignal` cancellation, stream destruction, and worker termination
- zero calls to printer resolution, MQTT, FTPS, camera, or print operations
- analysis/render behavior when `BAMBU_MODEL` is unset

### Minimum committed fixtures

- tiny sanitized no-support excerpt
- tiny normal support/transition/interface excerpt
- tiny tree-configured support excerpt
- tiny multi-extruder excerpt
- programmatically wrapped 3MF archives
- one small golden PNG per essential view class, minimizing binary churn

## 21. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Slicer marker changes | Incorrect or incomplete classification | Pin verified roles, expose slicer version/completeness, preserve unknown roles, add cross-version fixtures |
| Missing feature tags | False no-support conclusion | Return `support_present: null` and incomplete provenance |
| Exotic G-code state/arcs | Wrong geometry or totals | Explicit supported subset; structured rejection for unsupported extrusion motion |
| ZIP bombs/path tricks | Resource exhaustion or unsafe access | Lazy validation, normalized duplicates, declared and actual limits, timeouts/cancellation |
| Renderer output differs by OS | Golden-test instability | Pure integer/deterministic raster rules, fixed PNG settings, no fonts/GPU/native canvas |
| Preview blocks MCP transport | Poor availability/cancellation | Worker thread, bounded messages, termination on abort |
| PNG exceeds transport budget | Oversized tool response | 4 MP raw cap, 8 MiB encoded cap, explicit error/save-path guidance |
| Client ignores `ImageContent` | No inline preview | Text summary first and explicit `save_path` fallback |
| Native backend license/build burden | Distribution and maintenance exposure | Optional separate component, legal review, versioned adapter, TypeScript fallback |
| Mesh semantics overstated | Unsafe or misleading functional claims | Null MVP fields, confidence-scored heuristics, caller annotations |

## 22. Open questions

- Which Bambu/Orca versions should define the initially supported compatibility window, and how will fixtures be legally and reproducibly generated for each?
- Which metadata fields are sufficiently stable for filament diameter, density, support configuration, and active tool mapping across slicer versions?
- Should checksum absence be a warning while mismatch is fatal, as proposed, or should strict mode require a checksum?
- Which MCP clients reliably render mixed text/image results, and do any enforce lower payload limits than the server's 8 MiB cap?
- Should `save_path` be limited to configured output roots in deployments that expose the MCP server beyond a single trusted desktop user?
- What numeric raster rules and `pngjs` version pin produce byte-identical Windows/Linux goldens in CI?
- For future mesh analysis, what annotation schema best represents functional surfaces and acceptable support/clearance constraints?
- Does a separately distributed patched Studio backend fit project distribution goals after AGPL/GPL legal review? This plan is not legal advice.

## 23. MVP acceptance criteria

The MVP is complete only when all of the following are demonstrated:

1. `analyze_3mf_supports` accepts a local sliced 3MF and zero-based plate index with validated limits and deadline.
2. Complete tagged no-support files return `false`; missing-role files return `null`, never a false negative.
3. Body, transition, interface, combined, per-layer, and per-filament statistics match hand-calculated fixtures.
4. Linear, helical I/J arc, and `P1` full-circle metrics and bounds are exact within documented numeric tolerances.
5. Volume/mass formulas use commanded E and metadata; missing metadata yields `null` plus provenance/warnings.
6. Mesh-dependent contact, clearance, and blocked-opening fields remain `null` with `mesh_aware: false`.
7. `render_3mf_preview` supports all seven views, role toggles, inclusive layers, backgrounds, size constraints, and deterministic output.
8. Preview returns text, structured summary, and MCP PNG image content without base64 duplication.
9. Optional saving is atomic, honors overwrite policy, rejects symlink leaves, and leaves no partial or implicit temporary file.
10. Archive traversal, duplicate, symlink, encryption, bomb, checksum, malformed-input, timeout, and cancellation tests pass.
11. Integration tests prove both tools make zero printer/MQTT/FTPS calls and work without `BAMBU_MODEL`.
12. TypeScript build, new support suites, and repository behavior tests meet the recorded baseline or better on Windows and Linux; any unrelated baseline failures are reported explicitly.

Before committing or pushing eventual feature work, follow repository release rules: build first, run the behavior suite against `dist/index.js`, and never bypass printer model validation in slicing/printing paths. If a change is pushed to `main`, include the required patch-version bump and publish workflow specified by `AGENTS.md`.

## 24. Future extensions

### Mesh-aware contacts and accessibility

Parse all 3MF object and component meshes, units, transformations, and plate membership. Build a spatial index over triangles, intersect swept support extrusion envelopes with model geometry, cluster contact areas, and estimate interface footprint. Clearance, blocked-opening, and cavity-accessibility outputs are heuristics and must include definitions, confidence scores, and evidence.

Bearing seats, screw holes, seals, snap fits, and other functional geometry cannot be reliably inferred from arbitrary triangle meshes. Accept caller-provided sensitive-region annotations and evaluate them explicitly rather than presenting guessed semantics as fact.

### High-fidelity renderer

Provide an opt-in, separately maintained Studio-derived backend only after licensing, packaging, sandboxing, and headless-platform validation. Report its exact source commit, build version, renderer backend, and fallback behavior. Keep the TypeScript renderer available for deterministic CI and environments without compatible native graphics.

### Orientation comparison

Add an offline candidate workflow that transforms the model, invokes a bounded slicer process for each candidate, and compares results using the same public analyzer metrics. It must require `BAMBU_MODEL`, make no printer connection, preserve generated candidate evidence, and make scoring weights explicit. It remains separate from analysis/rendering because it creates machine-specific G-code and has substantially greater CPU, process, and safety implications.
