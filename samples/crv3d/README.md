# Vectric sample files

Drop `.crv3d` / `.crv` files here so the format can be inspected for a bulk
`crv3d -> dxf` converter. Nothing reads these yet — they are reference material.

Useful spread if you can manage it:

- one **simple** file (a single 2D shape, few vectors)
- one **busy** file (a real production layout, many vectors, maybe a 3D relief)
- one where you **already have the matching DXF export**, which makes it possible to
  check extracted vectors against a known-good answer

## Before pushing, check the sizes

GitHub rejects any single file over 100 MB, and warns over 50 MB. The rejection
happens at push time, *after* the commit, and unpicking it from history is a
nuisance — so check first:

```
du -h *.crv3d | sort -h
```

Under 50 MB each: push normally. Over that, use Git LFS (see the repo README).
