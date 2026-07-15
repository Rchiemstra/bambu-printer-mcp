# Sliced support analysis and preview

The server can inspect and render an already-sliced Bambu `.3mf`/`.gcode.3mf` without a printer connection, printer credentials, `BAMBU_MODEL`, Bambu Studio, a browser, or a GPU.

The implementation is based on the architecture and verification record in [`support_preview_and_analysis_plan.md`](./support_preview_and_analysis_plan.md). Bambu Studio is source reference only; the runtime does not embed, modify, invoke, or distribute it for these tools.

## `analyze_3mf_supports`

Required input:

```json
{
  "three_mf_path": "/models/job.gcode.3mf"
}
```

Optional inputs are `plate_index` (zero-based, default `0`), `timeout_ms` (default `30000`, maximum `120000`), `mesh_analysis` (default `true`), and `sensitive_regions`.

Support body, transition, and interface values come from `FEATURE` roles in the selected plate G-code. Path and commanded E values are exact for supported `G0/G1` and XY I/J `G2/G3` forms. Volume is derived from commanded E and filament diameter; mass additionally requires density. Missing material metadata produces `null` and a warning.

Mesh-aware values are explicitly heuristic. The implementation reads 3MF units, build items, object/component transforms, plate membership, vertices, and triangles; indexes triangles spatially; and samples swept support centerlines near the model. It returns contact clusters, interface footprint estimates, and local minimum clearance. It does not infer the meaning of arbitrary functional geometry.

Callers can annotate sensitive geometry:

```json
{
  "three_mf_path": "/models/job.gcode.3mf",
  "sensitive_regions": [
    {
      "id": "mounting-hole-1",
      "semantic": "M4 screw hole",
      "kind": "cylinder",
      "center": { "x": 42, "y": 18, "z": 6 },
      "radius_mm": 2.2,
      "height_mm": 12
    }
  ]
}
```

`blocked_openings` means a support extrusion envelope intersects a caller annotation. It is not a guarantee that support can or cannot be removed.

## `render_3mf_preview`

The renderer makes two streaming G-code passes in a worker thread and writes directly to RGBA and depth buffers. The default result is a `1200×900` feature-colored PNG with an isometric orthographic camera.

```json
{
  "three_mf_path": "/models/job.gcode.3mf",
  "view": "isometric",
  "show_model": true,
  "show_support": true,
  "show_support_interface": true,
  "show_travel": false,
  "background": "solid",
  "background_color": "#FFFFFF"
}
```

Views are `isometric`, `front`, `rear`, `left`, `right`, `top`, and `bottom`. `layer_start` and `layer_end` are inclusive. Each dimension is limited to `64..2048`, the total is limited to 4 megapixels, and encoded PNG output is limited to 8 MiB.

MCP result order is a JSON text fallback followed by `{type:"image", data, mimeType:"image/png"}`. The same summary is returned as `structuredContent`; image base64 is not duplicated there.

If `save_path` is provided, the destination parent must already exist. The server rejects symlink leaves, defaults `overwrite` to `false`, writes a private sibling temporary file, and publishes it atomically. No temporary image is retained without `save_path`.

## Security and completeness

The archive reader uses lazy ZIP entry streams and rejects traversal/absolute names, case-folded duplicates, encryption, symlink entries, unsafe compression ratios, excessive declared expansion, invalid plate selection, and MD5 mismatch. G-code is treated only as inert text; custom commands are never executed.

Unsupported extruding R arcs or non-XY planes fail with `UNSUPPORTED_EXTRUSION_ARC`. Missing feature tags return `support_present: null`, not `false`. Warnings and metric provenance are machine-readable.

Default limits include a 256 MiB archive, 4,096 entries, 1 GiB declared expansion, 512 MiB selected G-code, 10 million lines, 5 million motions, 1 MiB lines, and finite coordinates within ±1,000,000 mm.

## Reproducible Docker tests

The test image pins Node `22.18.0-bookworm-slim` by digest. It has no network at runtime and uses a read-only root filesystem with temporary files isolated in tmpfs.

```bash
docker compose build --pull test
docker compose run --rm test
```

To run only the support suite in the same image:

```bash
docker compose run --rm test sh -lc "npm run build && node --test tests/support-analysis.test.mjs"
```

The full `npm test` command builds TypeScript first and then runs repository and support tests against `dist/`.
