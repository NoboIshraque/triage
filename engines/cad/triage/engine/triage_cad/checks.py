# Fit and clearance checks between the board, its parts and the mechanical design
# (ROADMAP P2-5), with OpenCASCADE's booleans and distances through FreeCAD's Part.
#
# Every pair of drawn solids from different documents (the board document against an
# enclosure, a fan against an enclosure …) whose boxes come near each other is checked:
# a shared volume is an interference (an error), a gap smaller than the minimum
# clearance a warning. Solids touching face to face (a board resting on its bosses)
# share no volume and count as touching, not colliding.
from . import documents

VOLUME_EPSILON = 1e-3  # mm³: less than this is touching, not overlapping


def _solids(doc, obj):
    """The solids of a drawn object: (index, solid). A compound (the enclosure's base
    and lid) is checked part by part, so a problem names the part."""
    shape = obj.Shape
    solids = shape.Solids if shape.Solids else []
    return list(enumerate(solids))


def _near(a, b, margin):
    return not (
        a.XMax + margin < b.XMin
        or b.XMax + margin < a.XMin
        or a.YMax + margin < b.YMin
        or b.YMax + margin < a.YMin
        or a.ZMax + margin < b.ZMin
        or b.ZMax + margin < a.ZMin
    )


def _faces_touching(solid, other, limit=4):
    """Indices of `solid`'s faces that reach into `other` (for highlights)."""
    faces = []
    for index, face in enumerate(solid.Faces):
        try:
            if face.distToShape(other)[0] < 1e-6:
                faces.append(index)
        except Exception:
            continue
        if len(faces) >= limit:
            break
    return faces


def fit(doc_names, min_clearance=1.0):
    objects = []
    for name in doc_names:
        doc = documents.document(name)
        for obj in doc.Objects:
            if documents.shown(obj):
                objects.append((doc, obj))
    problems = []
    checked = 0
    for i, (doc_a, a) in enumerate(objects):
        for doc_b, b in objects[i + 1 :]:
            if doc_a is doc_b:
                continue
            if not _near(a.Shape.BoundBox, b.Shape.BoundBox, min_clearance):
                continue
            for part_a, solid_a in _solids(doc_a, a):
                for part_b, solid_b in _solids(doc_b, b):
                    if not _near(solid_a.BoundBox, solid_b.BoundBox, min_clearance):
                        continue
                    checked += 1
                    common = solid_a.common(solid_b)
                    volume = common.Volume if not common.isNull() else 0.0
                    entry = {
                        "a": {"doc": doc_a.Name, "object": a.Name, "label": a.Label, "solid": part_a},
                        "b": {"doc": doc_b.Name, "object": b.Name, "label": b.Label, "solid": part_b},
                    }
                    if volume > VOLUME_EPSILON:
                        entry.update(
                            severity="error",
                            kind="interference",
                            volume=volume,
                            message=f"{a.Label} collides with {b.Label} ({volume:.1f} mm³ overlap)",
                            facesA=_faces_touching(solid_a, solid_b),
                            facesB=_faces_touching(solid_b, solid_a),
                        )
                        problems.append(entry)
                        continue
                    distance = solid_a.distToShape(solid_b)[0]
                    if 1e-6 < distance < min_clearance:
                        entry.update(
                            severity="warning",
                            kind="clearance",
                            distance=distance,
                            message=f"{a.Label} is {distance:.2f} mm from {b.Label} (less than {min_clearance:g} mm)",
                        )
                        problems.append(entry)
    return {"problems": problems, "pairs": checked, "minClearance": min_clearance}
