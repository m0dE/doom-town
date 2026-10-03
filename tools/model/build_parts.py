# Doom Town — the marine's part meshes, modelled in Blender (bmesh, no viewport needed).
#
# Each part fills the bounds the TS rig gives it (tools/model/parts.json, from
# src/model/rig.ts), so the sprite-sourced texture of that part still lines up:
# the client textures every triangle by projecting it onto the face of the part's
# bounds it points toward (box projection). What this script adds is form: bevels,
# tapers, a rounded helmet, domed pads, octagonal limbs, knee pads, toe caps,
# pouches, a round barrel.
#
# Run inside Blender (headless works):  blender -b -P tools/model/build_parts.py
# or through the Blender MCP with exec(open(path).read()).
# Writes src/model/meshes.json: { part: { p: [x,y,z,...], i: [a,b,c,...] } }.
import bmesh, json, math, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/app/data/home/worktrees/ticket-b6152e3e/games/doom/tools/model'
PARTS = json.load(open(os.path.join(HERE, 'parts.json')))
OUT = os.path.join(HERE, '..', '..', 'src', 'model', 'meshes.json')


def box(bm, mn, mx):
    """A cube filling [mn, mx]."""
    r = bmesh.ops.create_cube(bm, size=1.0)
    c = [(a + b) / 2 for a, b in zip(mn, mx)]
    s = [b - a for a, b in zip(mn, mx)]
    for v in r['verts']:
        v.co = Vector((c[0] + v.co.x * s[0], c[1] + v.co.y * s[1], c[2] + v.co.z * s[2]))
    return r['verts']


def bevel(bm, verts, width, segs=2, only=None):
    """Bevel the edges among `verts` (optionally only those passing `only(edge)`)."""
    vs = set(verts)
    edges = [e for e in bm.edges if e.verts[0] in vs and e.verts[1] in vs and (only is None or only(e))]
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type='OFFSET', segments=segs, profile=0.5, affect='EDGES', clamp_overlap=True)


def prism(bm, mn, mx, sides=8, axis=1, taper=1.0, flare=1.0):
    """An n-sided prism along `axis` filling [mn, mx]; `taper` scales the max end, `flare` the min end."""
    c = [(a + b) / 2 for a, b in zip(mn, mx)]
    h = mx[axis] - mn[axis]
    o = [i for i in range(3) if i != axis]
    ra, rb = (mx[o[0]] - mn[o[0]]) / 2, (mx[o[1]] - mn[o[1]]) / 2
    rings = []
    for end, k in ((mn[axis], flare), (mx[axis], taper)):
        ring = []
        for i in range(sides):
            t = (i + 0.5) / sides * math.tau
            p = [0.0, 0.0, 0.0]
            p[axis] = end
            # an octagon whose flats touch the bounds (scaled so the box is filled)
            f = 1 / math.cos(math.pi / sides)
            p[o[0]] = c[o[0]] + math.cos(t) * ra * f * k
            p[o[1]] = c[o[1]] + math.sin(t) * rb * f * k
            p[o[0]] = min(max(p[o[0]], mn[o[0]] - 0.0), mx[o[0]])
            p[o[1]] = min(max(p[o[1]], mn[o[1]] - 0.0), mx[o[1]])
            ring.append(bm.verts.new(p))
        rings.append(ring)
    a, b = rings
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    return a + b


def scale_where(verts, pred, sx=1.0, sy=1.0, sz=1.0, about=None):
    vs = [v for v in verts if pred(v.co)]
    if not vs:
        return
    c = about or sum((v.co for v in vs), Vector()) / len(vs)
    for v in vs:
        d = v.co - c
        v.co = c + Vector((d.x * sx, d.y * sy, d.z * sz))


def lerp_y_taper(verts, y0, y1, k0, k1, cx, cz):
    """Scale x/z about (cx, cz) by a factor going k0 (at y0) → k1 (at y1)."""
    for v in verts:
        t = 0.0 if y1 == y0 else min(1.0, max(0.0, (v.co.y - y0) / (y1 - y0)))
        k = k0 + (k1 - k0) * t
        v.co.x = cx + (v.co.x - cx) * k
        v.co.z = cz + (v.co.z - cz) * k


def build(part):
    n, mn, mx = part['name'], part['min'], part['max']
    bm = bmesh.new()
    cx, cy, cz = [(a + b) / 2 for a, b in zip(mn, mx)]
    side = 1 if cz > 0 else -1

    if n in ('pelvis',):
        vs = box(bm, mn, mx)
        lerp_y_taper(bm.verts, mn[1], mx[1], 0.82, 1.0, cx, cz)        # narrower at the crotch
        bevel(bm, bm.verts, 1.4, 2)
    elif n == 'belt':
        box(bm, mn, mx)
        bevel(bm, bm.verts, 0.6, 1)
        # buckle and pouches stand proud of the belt (still inside its bounds' projection)
        box(bm, [mx[0] - 0.9, mn[1] + 0.4, -2.2], [mx[0] + 0.5, mx[1] - 0.3, 2.2])
        for z in (-6.0, 6.0):
            pv = box(bm, [mx[0] - 2.5, mn[1] - 1.2, z - 2.0], [mx[0] + 0.4, mx[1] - 0.2, z + 2.0])
            bevel(bm, pv, 0.4, 1)
        for z in (-8.6, 8.6):
            pv = box(bm, [-5.5, mn[1] - 1.5, z - 1.0 if z < 0 else z - 0.8], [0.5, mx[1] - 0.2, z + 0.8 if z < 0 else z + 1.0])
            bevel(bm, pv, 0.4, 1)
    elif n == 'torso':
        box(bm, mn, mx)
        lerp_y_taper(bm.verts, mn[1], mx[1], 0.84, 1.0, cx, cz)        # V-shaped chest
        bevel(bm, bm.verts, 2.2, 2)
        # chest plates: two raised slabs on the front
        for z in (-4.3, 4.3):
            pv = box(bm, [mx[0] - 1.0, 38.5, z - 3.8], [mx[0] + 0.9, 45.0, z + 3.8])
            bevel(bm, pv, 0.7, 2)
        # back pack plate
        pv = box(bm, [mn[0] - 1.2, 36.5, -6.0], [mn[0] + 0.5, 45.0, 6.0])
        bevel(bm, pv, 0.6, 1)
    elif n == 'helmet':
        box(bm, mn, [mx[0], mx[1] + 1.5, mx[2]])
        bevel(bm, bm.verts, 3.6, 3)                                      # rounded shell
        for v in bm.verts:                                               # flatten the cheeks slightly
            if v.co.y < mn[1] + 2.0:
                v.co.x = cx + (v.co.x - cx) * 0.92
        # jaw guard
        pv = box(bm, [mx[0] - 3.5, mn[1] - 0.2, -3.6], [mx[0] - 0.2, mn[1] + 2.4, 3.6])
        bevel(bm, pv, 0.6, 1)
    elif n == 'cap':
        box(bm, mn, [mx[0], mx[1] - 0.5, mx[2]])
        bevel(bm, bm.verts, 1.6, 2)
    elif n == 'visor':
        # wraps around the front of the helmet: a bent strip
        prism(bm, [mn[0] - 3.0, mn[1], mn[2]], mx, sides=10, axis=1)
        for v in bm.verts:
            v.co.x = max(v.co.x, mn[0])                                  # cut the back off
        bevel(bm, bm.verts, 0.5, 1, only=lambda e: abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-3)
    elif n in ('padR', 'padL'):
        # a deep pauldron: taller than its bounds (the texture projection clamps),
        # domed on top, rolled at the rim
        box(bm, [mn[0] - 0.5, mn[1] - 2.0, mn[2] if side > 0 else mn[2] - 0.8], [mx[0] + 0.5, mx[1] + 1.2, mx[2] + 0.8 if side > 0 else mx[2]])
        bevel(bm, bm.verts, 3.2, 3, only=lambda e: min(e.verts[0].co.y, e.verts[1].co.y) > mn[1] - 1.5)
        bevel(bm, [v for v in bm.verts if v.co.y < mn[1] - 1.4], 1.0, 1)
    elif n in ('padCapR', 'padCapL'):
        box(bm, mn, mx)
        bevel(bm, bm.verts, 1.4, 2)
    elif n == 'antenna':
        prism(bm, mn, mx, sides=6, axis=1, taper=0.6)
        box(bm, [mn[0] - 0.4, mx[1] - 1.0, mn[2] - 0.4], [mx[0] + 0.4, mx[1], mx[2] + 0.4])
    elif n in ('uArmR', 'uArmL'):
        prism(bm, mn, mx, sides=8, axis=1, taper=1.0, flare=0.82)        # bicep thicker at the top
        bevel(bm, bm.verts, 0.5, 1, only=lambda e: abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-3)
    elif n in ('fArmR', 'fArmL'):
        prism(bm, mn, mx, sides=8, axis=1, taper=0.8, flare=0.92)        # gauntlet, a little wider at the wrist
        bevel(bm, bm.verts, 0.6, 1, only=lambda e: abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-3)
        # cuff ring at the wrist
        pv = prism(bm, [mn[0] + 0.3, mn[1], mn[2] + 0.3], [mx[0] - 0.3, mn[1] + 1.2, mx[2] - 0.3], sides=8, axis=1)
    elif n in ('handR', 'handL'):
        box(bm, mn, mx)
        bevel(bm, bm.verts, 1.0, 2)
        # thumb
        pv = box(bm, [mx[0] - 1.5, mx[1] - 2.2, cz - 0.9 * side - 0.8], [mx[0] + 0.6, mx[1] - 0.4, cz - 0.9 * side + 0.8])
        bevel(bm, pv, 0.3, 1)
    elif n in ('thighR', 'thighL'):
        prism(bm, mn, mx, sides=8, axis=1, taper=1.0, flare=0.84)
        bevel(bm, bm.verts, 0.8, 1, only=lambda e: abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-3)
        # knee pad
        pv = box(bm, [mx[0] - 1.6, mn[1] - 1.0, cz - 3.4], [mx[0] + 1.0, mn[1] + 5.0, cz + 3.4])
        bevel(bm, pv, 1.2, 2)
    elif n in ('shinR', 'shinL'):
        vs = box(bm, mn, mx)
        lerp_y_taper(bm.verts, 3.5, mx[1], 1.0, 0.86, cx, cz)          # calf narrows above the boot
        bevel(bm, bm.verts, 1.3, 2)
        # boot cuff
        pv = box(bm, [mn[0] - 0.4, 3.4, mn[2] - 0.4], [mx[0] + 0.4, 5.0, mx[2] + 0.4])
        bevel(bm, pv, 0.5, 1)
        # sole
        box(bm, [mn[0] - 0.3, 0.0, mn[2] - 0.2], [mx[0] + 0.2, 0.9, mx[2] + 0.2])
    elif n in ('toeR', 'toeL'):
        box(bm, [mn[0] - 1.0, mn[1], mn[2]], mx)
        bevel(bm, bm.verts, 1.4, 2, only=lambda e: max(e.verts[0].co.y, e.verts[1].co.y) > 0.5)
        box(bm, [mn[0] - 1.0, 0.0, mn[2] - 0.2], [mx[0] + 0.3, 0.9, mx[2] + 0.2])
    elif n == 'gunBody':
        box(bm, [mn[0] + 2.0, mn[1], mn[2]], mx)                        # receiver
        bevel(bm, bm.verts, 0.4, 1)
        pv = box(bm, [mn[0], mn[1] - 0.6, -0.9], [mn[0] + 3.0, mn[1] + 1.8, 0.9])   # stock
        bevel(bm, pv, 0.4, 1)
        pv = box(bm, [0.2, mn[1] - 3.0, -0.7], [1.6, mn[1] + 0.2, 0.7])  # pistol grip
        bevel(bm, pv, 0.3, 1)
        pv = box(bm, [1.0, mx[1] - 0.1, -0.5], [5.0, mx[1] + 0.9, 0.5])  # sight rail
        bevel(bm, pv, 0.2, 1)
    elif n == 'gunBarrel':
        prism(bm, [mn[0], mn[1], mn[2]], mx, sides=8, axis=0)
        pv = prism(bm, [mn[0], mn[1] - 0.6, mn[2] - 0.3], [mn[0] + 4.0, mx[1] + 0.2, mx[2] + 0.3], sides=8, axis=0)  # handguard
        pv = prism(bm, [mx[0] - 1.4, mn[1] - 0.25, mn[2] - 0.25], [mx[0], mx[1] + 0.25, mx[2] + 0.25], sides=8, axis=0)  # muzzle
    elif n == 'gunMag':
        box(bm, mn, mx)
        for v in bm.verts:                                               # curved magazine
            if v.co.y < (mn[1] + mx[1]) / 2:
                v.co.x += 0.8
        bevel(bm, bm.verts, 0.3, 1)
    else:
        bm.free()
        return None                                                      # effects keep their boxes

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.verts.index_update()
    p = [round(c, 3) for v in bm.verts for c in v.co]
    i = [v.index for f in bm.faces for v in f.verts]
    bm.free()
    return {'p': p, 'i': i}


out = {}
tris = 0
for part in PARTS:
    m = build(part)
    if m:
        out[part['name']] = m
        tris += len(m['i']) // 3
with open(OUT, 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'wrote {OUT}: {len(out)} parts, {tris} triangles')
