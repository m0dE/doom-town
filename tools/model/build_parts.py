# Doom Town — the marine's part meshes, modelled in Blender (bmesh, no viewport needed).
#
# Low-poly and faceted after the user's reference sheet (2026-10-03): a round
# faceted helmet with a wide visor wrapped around its front, a V-shaped chest with
# raised plates, domed shoulder sleeves, thick 8-sided limbs, boots with a flared
# knee cuff and a wide sole, a pump shotgun. Each part sits in the bounds the TS
# rig gives it (tools/model/parts.json, from src/model/rig.ts; one flat colour per
# part, so the projection the client textures with does not matter).
#
# Run inside Blender (headless works):  blender -b -P tools/model/build_parts.py
# or with the bpy module:                python -c "import bpy; exec(open('tools/model/build_parts.py').read())"
# or through the Blender MCP with exec(open(path).read()).
# Writes src/model/meshes.json: { part: { p: [x,y,z,...], i: [a,b,c,...] } }.
import bmesh, json, math, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.path.join(os.getcwd(), 'tools', 'model')
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



def loft(bm, mn, mx, axis=1, sides=8, profile=((0, 1), (1, 1)), shift=None):
    """Rings of an n-gon along `axis` through [mn, mx]: profile (t 0..1, scale) pairs;
    `shift(t)` → (da, db) moves a ring across the axis. Flats touch the bounds at scale 1."""
    o = [i for i in range(3) if i != axis]
    c = [(a + b) / 2 for a, b in zip(mn, mx)]
    ra, rb = (mx[o[0]] - mn[o[0]]) / 2, (mx[o[1]] - mn[o[1]]) / 2
    f = 1 / math.cos(math.pi / sides)
    rings = []
    for t, k in profile:
        da, db = shift(t) if shift else (0.0, 0.0)
        ring = []
        for i in range(sides):
            a = (i + 0.5) / sides * math.tau
            p = [0.0, 0.0, 0.0]
            p[axis] = mn[axis] + (mx[axis] - mn[axis]) * t
            p[o[0]] = c[o[0]] + da + math.cos(a) * ra * f * k
            p[o[1]] = c[o[1]] + db + math.sin(a) * rb * f * k
            p[o[0]] = min(max(p[o[0]], c[o[0]] + da - ra * k), c[o[0]] + da + ra * k)
            p[o[1]] = min(max(p[o[1]], c[o[1]] + db - rb * k), c[o[1]] + db + rb * k)
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    return [v for r in rings for v in r]


def ellipsoid(bm, mn, mx, segs=10, rings=6):
    """A faceted ellipsoid filling [mn, mx]."""
    r = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    c = [(a + b) / 2 for a, b in zip(mn, mx)]
    h = [(b - a) / 2 for a, b in zip(mn, mx)]
    for v in r['verts']:
        # uvsphere is Z-up: its Z is our Y
        x, y, z = v.co.x, v.co.z, v.co.y
        v.co = Vector((c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]))
    return r['verts']


def band(bm, c, rx, rz, y0, y1, a0, a1, segs=8, thick=0.8):
    """A curved strip around a vertical axis at c (x, z): angles a0..a1 (0 = +X), radii rx, rz."""
    outer, inner = [], []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * i / segs
        for r, out in ((1.0, outer), (None, inner)):
            k = 1.0 if r else (1 - thick / max(rx, rz))
            x, z = c[0] + math.cos(a) * rx * k, c[1] + math.sin(a) * rz * k
            out.append((bm.verts.new((x, y0, z)), bm.verts.new((x, y1, z))))
    for i in range(segs):
        (o0, o1), (p0, p1) = outer[i], outer[i + 1]
        (i0, i1), (q0, q1) = inner[i], inner[i + 1]
        bm.faces.new((o0, p0, p1, o1))
        bm.faces.new((i1, q1, q0, i0))
        bm.faces.new((o1, p1, q1, i1))
        bm.faces.new((i0, q0, p0, o0))
    for (a0_, a1_), (b0, b1) in ((outer[0], inner[0]), (outer[-1], inner[-1])):
        bm.faces.new((a0_, a1_, b1, b0))


# The helmet's dome (model space): centre x, y, radii; the visor, mouth and guards follow it.
H = {'cx': 0.4, 'cy': 51.0, 'rx': 5.6, 'ry': 5.4, 'rz': 6.1}


def helm_band(bm, y0, y1, a0, a1, out=0.8, thick=1.0, segs=8):
    """A strip around the helmet dome between heights y0..y1, angles a0..a1 (0 = front),
    `out` units proud of the dome at the strip's mid height (negative: recessed)."""
    ym = (y0 + y1) / 2
    k = math.sqrt(max(0.05, 1 - ((ym - H['cy']) / H['ry']) ** 2))
    band(bm, (H['cx'], 0.0), H['rx'] * k + out, H['rz'] * k + out, y0, y1, a0, a1, segs=segs, thick=thick)


def signed_volume(bm):
    v = 0.0
    for f in bm.faces:
        vs = [x.co for x in f.verts]
        for k in range(1, len(vs) - 1):
            v += vs[0].dot(vs[k].cross(vs[k + 1])) / 6
    return v


def build(part):
    n, mn, mx = part['name'], part['min'], part['max']
    bm = bmesh.new()
    cx, cy, cz = [(a + b) / 2 for a, b in zip(mn, mx)]
    side = 1 if cz > 0 else -1

    if n == 'pelvis':
        loft(bm, mn, mx, profile=((0, 0.84), (0.6, 0.97), (1, 1)))
    elif n == 'belt':
        loft(bm, mn, mx, sides=10)
    elif n == 'pouchF':
        for z0, z1 in ((mn[2], -1.6), (1.6, mx[2])):
            pv = box(bm, [mn[0], mn[1] + 0.2, z0], [mx[0], mx[1], z1])
            bevel(bm, pv, 0.35, 1)
        pv = box(bm, [mn[0] - 0.2, mn[1] + 0.7, -1.3], [mx[0] - 0.6, mx[1] - 0.5, 1.3])   # buckle
        bevel(bm, pv, 0.2, 1)
    elif n == 'pouchB':
        pv = box(bm, mn, mx)
        bevel(bm, pv, 0.5, 1)
    elif n == 'torso':
        # V chest: narrow at the waist, broad and squared at the shoulders
        loft(bm, mn, mx, profile=((0, 0.76), (0.3, 0.84), (0.72, 0.98), (0.93, 0.98), (1, 0.9)))
        for z in (-3.9, 3.9):                                           # chest plates
            pv = box(bm, [mx[0] - 1.6, 37.5, z - 3.4], [mx[0] + 0.1, 45.4, z + 3.4])
            bevel(bm, pv, 0.5, 1)
        pv = box(bm, [mn[0] - 0.3, 36.0, -5.6], [mn[0] + 1.6, 45.6, 5.6])   # back plate
        bevel(bm, pv, 0.5, 1)
    elif n == 'helmet':
        # The Doomguy helmet. A faceted dome; around its open face a brow that overhangs
        # the (recessed, separate) visor, cheek guards down both sides, a chin guard under
        # the mouth; round ear pieces, a neck guard flaring at the back, a ridge on top.
        ellipsoid(bm, [H['cx'] - H['rx'], H['cy'] - H['ry'], -H['rz']], [H['cx'] + H['rx'], H['cy'] + H['ry'], H['rz']], segs=12, rings=8)
        for v in bm.verts:
            v.co.y = max(v.co.y, mn[1] + 0.9)
        # the face opening: the visor and mouth sit in it, framed by the guards
        face = [f for f in bm.faces if abs(math.atan2(f.calc_center_median().z, f.calc_center_median().x - H['cx'])) < 1.0
                and 45.5 < f.calc_center_median().y < 52.9]
        bmesh.ops.delete(bm, geom=face, context='FACES_ONLY')
        helm_band(bm, 52.5, 53.9, -1.05, 1.05, out=0.5)                 # brow
        for a0, a1 in ((0.9, 1.35), (-1.35, -0.9)):                     # cheek guards
            helm_band(bm, 46.0, 52.8, a0, a1, out=0.9)
        helm_band(bm, 45.0, 47.0, -1.0, 1.0, out=0.9)                   # chin guard
        helm_band(bm, 45.0, 47.6, 1.9, 4.38, out=0.7)                   # neck guard
        for z0, z1 in ((H['rz'] - 0.6, H['rz'] + 1.0), (-H['rz'] - 1.0, -H['rz'] + 0.6)):   # ear pieces
            loft(bm, [H['cx'] - 2.4, 48.0, z0], [H['cx'] + 2.4, 52.8, z1], axis=2, sides=8)
        pv = box(bm, [H['cx'] - 4.4, H['cy'] + H['ry'] - 1.2, -0.7], [H['cx'] + 3.6, H['cy'] + H['ry'] + 0.3, 0.7])  # ridge
        for v in pv:                                                     # follows the dome down front and back
            v.co.y -= 0.12 * (v.co.x - H['cx']) ** 2 / 4
        bevel(bm, pv, 0.3, 1)
    elif n == 'visor':
        helm_band(bm, mn[1], mx[1], -1.02, 1.02, out=-0.4, thick=1.2, segs=8)
    elif n == 'mouth':
        helm_band(bm, mn[1], mx[1], -1.02, 1.02, out=-0.9, thick=1.4, segs=6)
    elif n in ('padR', 'padL'):
        # a domed sleeve over the deltoid: the lower half pulled in
        ellipsoid(bm, mn, mx, segs=8, rings=6)
        for v in bm.verts:
            if v.co.y < cy:
                k = 1 - 0.35 * (cy - v.co.y) / (cy - mn[1])
                v.co.x = cx + (v.co.x - cx) * k
                v.co.z = cz + (v.co.z - cz) * k
    elif n in ('uArmR', 'uArmL'):
        loft(bm, mn, mx, profile=((0, 0.84), (0.55, 1), (1, 0.9)))      # bicep
    elif n in ('fArmR', 'fArmL'):
        loft(bm, mn, mx, profile=((0, 0.8), (0.65, 1), (1, 0.92)))      # thick forearm, narrower wrist
    elif n in ('handR', 'handL'):
        pv = box(bm, mn, [mx[0], mx[1] - 0.6, mx[2]])
        bevel(bm, pv, 0.9, 1)
        pv = box(bm, [mx[0] - 1.6, mn[1] + 0.3, cz - 2.2], [mx[0] + 0.5, mn[1] + 3.0, cz + 2.2])   # knuckles
        bevel(bm, pv, 0.4, 1)
        pv = box(bm, [mn[0] + 0.6, mx[1] - 1.6, mn[2] - 0.2], [mx[0] - 0.6, mx[1], mx[2] + 0.2])  # cuff
        bevel(bm, pv, 0.3, 1)
    elif n in ('thighR', 'thighL'):
        loft(bm, mn, mx, profile=((0, 0.8), (0.45, 0.96), (1, 1)))
    elif n in ('shinR', 'shinL'):
        # a boot: wide over the foot, narrower at the shin, a flared cuff over the knee
        loft(bm, mn, mx, profile=((0, 0.94), (0.2, 0.86), (0.55, 0.8), (0.74, 0.86), (0.77, 1.0), (1, 0.97)),
             shift=lambda t: (-0.6 * (1 - t), 0.0))
        pv = box(bm, [mx[0] - 1.2, 13.5, cz - 2.8], [mx[0] + 0.6, 18.4, cz + 2.8])   # knee plate
        bevel(bm, pv, 0.5, 1)
    elif n in ('toeR', 'toeL'):
        pv = box(bm, mn, mx)
        bevel(bm, pv, 1.4, 1, only=lambda e: max(e.verts[0].co.y, e.verts[1].co.y) > mn[1] + 1.0)
    elif n in ('soleR', 'soleL'):
        pv = box(bm, mn, mx)
        bevel(bm, pv, 0.3, 1)
    elif n == 'gunStock':
        pv = box(bm, [mn[0], mn[1] + 1.2, mn[2]], mx)
        for v in pv:                                                     # the butt drops below the line
            if v.co.x < -5.0:
                v.co.y -= (-5.0 - v.co.x) * 0.3
        bevel(bm, pv, 0.3, 1)
    elif n == 'gunBody':
        pv = box(bm, [mn[0], -1.2, mn[2]], mx)                         # receiver
        bevel(bm, pv, 0.25, 1)
        pv = box(bm, [-0.6, mn[1], -0.55], [1.4, -1.2, 0.55])           # trigger guard
        bevel(bm, pv, 0.2, 1)
    elif n == 'gunBarrel':
        loft(bm, [mn[0], -0.2, -0.75], [mx[0], 1.3, 0.75], axis=0, sides=8)      # barrel
        loft(bm, [mn[0], mn[1], -0.65], [mx[0] - 2.0, 0.1, 0.65], axis=0, sides=8)  # magazine tube
    elif n == 'gunPump':
        pv = box(bm, mn, mx)
        bevel(bm, pv, 0.35, 1)
        for x in (9.4, 11.0, 12.6):                                     # grip ridges
            pv = box(bm, [x - 0.3, mn[1] - 0.2, mn[2] - 0.15], [x + 0.3, mx[1] - 0.4, mx[2] + 0.15])
    else:
        bm.free()
        return None                                                      # effects keep their boxes

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # recalc_face_normals can still leave a closed part inside-out (the ellipsoid's
    # axis swap mirrors it; it flipped padR and not padL): outward means a positive volume
    if signed_volume(bm) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
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
