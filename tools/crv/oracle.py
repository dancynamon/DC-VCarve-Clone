#!/usr/bin/env python3
"""Compare crvparse.js output against each file's own embedded preview (VCarve's render of the same vectors).

    node cam-engine/crvcorpus.js <dir> --export /tmp/crv-oracle
    python3 tools/crv/oracle.py /tmp/crv-oracle            # needs pillow + numpy

Prints, per file, the share of the preview's ink that our vectors cover (low when the preview also shows toolpath
previews, model renders or bitmaps — those are dropped on purpose) and the share of OUR ink that the preview
covers (this one must stay near 1.0: anything we draw that VCarve did not is a decode error). Writes <name>.cmp.png
(preview on top, our render below) for eyeballing.
"""
from PIL import Image, ImageDraw
import json, numpy as np, glob, os, sys

def ink(g):
    a = np.array(g.convert('RGB')).astype(int); mx = a.max(2); mn = a.min(2)
    white = mn > 235; grey = (mx - mn < 18) & (mn > 150)          # background, grid dashes, sheet fill
    return ~(white | grey)

def render(sh, W, H, x0, y0, sc):
    im = Image.new('L', (W, H), 255); dr = ImageDraw.Draw(im)
    for L in sh['layers']:
        for c in L['contours']:
            pts = [((p['x'] - x0) * sc, H - (p['y'] - y0) * sc) for p in c['pts']]
            if len(pts) < 2: continue
            if c['closed']: pts.append(pts[0])
            dr.line(pts, fill=0, width=1)
    return np.array(im) < 128

def dil(m, k=1):
    out = m.copy()
    for dx in range(-k, k + 1):
        for dy in range(-k, k + 1): out |= np.roll(np.roll(m, dx, 0), dy, 1)
    return out

def score(a, b):
    if a.sum() == 0 or b.sum() == 0: return (0.0, 0.0)
    return ((a & dil(b)).sum() / a.sum(), (b & dil(a)).sum() / b.sum())

def fit(sh, a, W, H, job):
    """The preview frames the job sheet with a small margin; search margin + a few px of offset."""
    best = None
    for m in [0.0, 0.02, 0.025, 0.03, 0.04, 0.05]:
        sc = W / (job['w'] * (1 + 2 * m)); x0 = -job['w'] * m
        for y0 in [-job['h'] * m, H / sc - job['h'] * (1 + m)]:
            s = score(a, render(sh, W, H, x0, y0, sc))
            if best is None or sum(s) > sum(best[0]): best = (s, x0, y0, sc)
    s, x0, y0, sc = best; bx, by = x0, y0
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            s2 = score(a, render(sh, W, H, x0 - dx / sc, y0 - dy / sc, sc))
            if sum(s2) > sum(s): s, bx, by = s2, x0 - dx / sc, y0 - dy / sc
    return s, bx, by, sc

def main(d):
    worst = 1.0
    for jf in sorted(glob.glob(os.path.join(d, '*.json'))):
        n = os.path.basename(jf)[:-5]; gf = os.path.join(d, n + '.gif')
        if not os.path.exists(gf): print(n.ljust(36), 'no preview'); continue
        g = Image.open(gf); W, H = g.size; a = ink(g); sh = json.load(open(jf)); job = sh['job']
        if not job or not job['w']: print(n.ljust(36), 'no job size'); continue
        sh = {'layers': [L for L in sh['layers'] if L.get('visible', True)], 'job': job}   # VCarve renders visible layers only
        s, x0, y0, sc = fit(sh, a, W, H, job); worst = min(worst, s[1])
        print(n.ljust(36), f'preview ink {a.sum():7d}   preview covered by ours {s[0]:.3f}   ours covered by preview {s[1]:.3f}')
        b = render(sh, W, H, x0, y0, sc)
        both = Image.new('RGB', (W, 2 * H + 4), (128, 128, 128)); both.paste(g.convert('RGB'), (0, 0))
        both.paste(Image.fromarray(np.where(b, 0, 255).astype('uint8')).convert('RGB'), (0, H + 4)); both.save(os.path.join(d, n + '.cmp.png'))
    print('\nworst "ours covered by preview":', round(worst, 3), '(expect > 0.75; 1.0 = every decoded stroke is in VCarve\'s own render)')

if __name__ == '__main__': main(sys.argv[1] if len(sys.argv) > 1 else '.')
