# Reading Vectric project files (.crv3d)

`cam-engine/crv3dparse.js`. Everything below is verified against the posted `.tap` for the
same job — the same ground-truth discipline as the rest of the harness.

## The container: an ordinary OLE2 compound file

A `.crv3d` starts with `d0 cf 11 e0 a1 b1 1a e1` — Microsoft structured storage, the format
old Office documents used. A little filesystem of named streams in 512-byte sectors, fully
documented, nothing compressed or encrypted (byte entropy 5.36 bits). `parseCfb()` reads it
completely: DIFAT → FAT → directory tree → per-stream chains, with small streams in the
mini-stream.

Streams in the LGC-50 boards (all five identical in layout):

| stream | board 4 size | contents |
|---|---|---|
| `VersionData/Version` | 176 | app/format version |
| `PreviewData/Preview2D_GIF` | 1,774 | a plain GIF thumbnail |
| `VectorData/MaterialSize` | 62 | stock setup |
| `VectorData/DocumentData` | 21,601 | not decoded |
| `VectorData/2dDataV2` | 166,608 | the drawing — **true splines**, f64 |
| `ModelObjects/ObjectData` | 2,947 | not decoded |
| `Toolpaths/ToolpathData` | 125,081 | **decoded** — see below |
| `Toolpaths/ToolpathPosData` | 53 | not decoded |
| `Toolpaths/Simulation` | 52 | not decoded |

## Toolpaths/ToolpathData — decoded

MFC CArchive, the same serialisation as the `.tool` database. Three layers are readable:

**1. Class markers** (`ff ff`, u16 schema, u16 len, name): `mcDrillingToolpath`,
`mcProfileToolpath`, `mcCompositeToolpath`, `mcContourGroupToolpath`, tool classes,
`utParameter`, `veEntityGroup`. Each appears once, at first use — CArchive names a class
once and references it by index after, which is why record-finding anchors on other
structure.

**2. Tool records** — byte-identical layout to the `.tool` database, so
`tooldbparse.parseToolDb()` reads them unchanged. One record **per toolpath**, in toolpath
order, with the operator's per-toolpath overrides **baked in**: boards 3/4 carry T3 at feed
60 where the database tool says 80 — exactly the override the fixtures had annotated by
hand. This independently confirms every override the fixtures declare.

**3. The computed toolpaths themselves**, fully tessellated, as 32-byte segment records:

```
u32 tag  = 32        only line segments exist; arcs arrive pre-flattened, which
u32 dim  = 3         independently confirms the NURBS finding in ARC-FITTING.md
f32 x1, y1, z1       segment start
f32 x2, y2, z2       segment end (repeated as the next record's start)
```

Contiguous records form one continuous cut at one depth (tab ramps show as z changes
mid-run). Coordinates are machine-space and match the posted `.tap` exactly — board 3's T9
finishing pass is a 100-segment run starting at `(0.7117, 87.0545)`, board 4's T5 at
`(3.6712, 72.2940)`.

**Caveat:** a board's file carries runs for toolpaths that were *not* posted for that board
(the LGC project keeps sibling boards' geometry around, offset on the sheet — board 3's
file contains board 4's T5 cuts at x≈30). Select runs by geometry, never by "it's in the
file".

## What this settled

**Board 3 → PARITY.** The T9 finish's 148.23° start angle is an operator-placed start
point. It exists nowhere in the DXF (DXF re-canonicalises circles to start at +x; the
source's four bulge vertices sit at 0/90/180/270° to five decimals). The fixture now reads
the stored finishing run — selected by geometry: the run whose points all sit on the
r=0.6875 finish circle — and passes its first point to `profileOp` as `startAt`. Board 4's
T9 gets the same treatment (it was masked behind the T5 failure; a full per-pass audit
found it).

**Board 4 → explained, deliberately not "fixed."** The 2dDataV2 stream contains the true
cubic bezier for the spline contours (anchor `(3.50109, 72.20942)`, first control
`(3.31824, 72.59499)` → exact endpoint tangent **115.372°**). Vectric's stored toolpath for
that contour is 65 segments with a first chord at **116.425°** — and the reference entry
point is perpendicular to *that chord* (116.44° implied), not to the true tangent. Our
entry is perpendicular to *our* first chord (115.90°, from the DXF's 0.02" flattening).

Same policy, different sampling density, of the same true curve. The 0.0018" is a
tessellation artifact on both sides — Vectric's entry is a full degree off its own true
tangent. Matching it exactly would mean cloning Vectric's tessellator step selection, which
would be imitating an artifact, not correcting an error. It stays a KNOWN DIFF with this
paragraph as its reason.

**The print jig's cut order** would yield to the same treatment — the stored runs are in
cutting order — but its `.crv` project file is not in the repo. Drop it next to the fixture
and the same decoder applies.

## Not yet decoded

- **2dDataV2 framing.** The bezier span above was located by searching for known
  coordinates; the entity headers and span counts around it are unmapped. That is the next
  piece of work if the drawing itself is ever needed (e.g. importing .crv3d instead of DXF,
  which would carry true tangents and operator start points into the app natively).
- `DocumentData`, `ObjectData`, `ToolpathPosData`, `Simulation`, `MaterialSize` fields.
- Toolpath *parameters* (`utParameter` records) — depths and speeds are currently
  cross-checked through the tool records and the geometry instead.

## Tests

`importtest.js` anchors the decoder on: the 9-stream inventory, the GIF magic, the 6 tool
records in toolpath order with the feed-60 override, board 3's T9 run (101 points, closes
on itself, all points on the finish circle, starts at the `.tap` start point), board 3's
first pocket ring entry, board 4's T5 run (66 points at Vectric's own tessellation), and
clean rejection of non-CFB input.
