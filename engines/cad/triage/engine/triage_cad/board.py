# The circuit board as solids in the CAD engine (ROADMAP P2-3 … P2-5): what the KiCad
# engine's GetBoard3D says (outline, thickness, holes, footprints), built with
# FreeCAD's Part module so the 3D view draws it beside the enclosure and OpenCASCADE
# can check fits against it.
#
# Coordinates: KiCad's board coordinates are in mm with Y down; here X stays, Y flips
# (y3d = -y) and the board's bottom face is z = 0, its top z = thickness. A part on the
# front stands on the top face, a part on the back hangs below z = 0.
#
# Parts are boxes over their courtyard, as tall as their "Height" field says, or as
# their footprint's name says (ESTIMATES) when the board has no height for them. KiCad's
# 3D model files aren't loaded yet. A part with no known height isn't drawn.
import re

import FreeCAD
import Part

from . import documents
from .documents import INVALID_PARAMS, RpcError

DOCUMENT = "TriageBoard"

# The last board.update result: the enclosure copies its inputs from it.
LAST = {}

# Footprint names that tell a part's height (mm above its side of the board).
ESTIMATES = [
    # Round through-hole LEDs: a 3 mm LED stands about 5.3 mm, a 5 mm one 8.7 mm.
    (re.compile(r"LED_D(\d+(?:\.\d+)?)mm"), lambda m: 1.75 * float(m.group(1))),
    (re.compile(r"Pin(?:Header|Socket)_\d+x\d+_P2\.54mm_Vertical"), lambda m: 8.5),
    (re.compile(r"TO-220"), lambda m: 19.0),
    (re.compile(r"TO-92"), lambda m: 5.0),
    (re.compile(r"_D(\d+(?:\.\d+)?)mm_.*Horizontal"), lambda m: float(m.group(1))),
    (re.compile(r"D_DO-41"), lambda m: 2.7),
    (re.compile(r"SW_PUSH_6mm"), lambda m: 5.0),
    (re.compile(r"BarrelJack"), lambda m: 11.0),
    (re.compile(r"CP_Radial_D(\d+(?:\.\d+)?)mm"), lambda m: 2.0 * float(m.group(1)) + 1.0),
]

# Colours (0..1 RGB) the view uses: solder mask green, dark parts, black connectors.
BOARD_COLOUR = (0.12, 0.36, 0.20)
PART_COLOUR = (0.22, 0.24, 0.27)
CONNECTOR_COLOUR = (0.08, 0.08, 0.09)
TALL_TOLERANCE = 1e-6


def _vec(point, z=0.0):
    return FreeCAD.Vector(float(point["x"]), -float(point["y"]), z)


def _face(points):
    """A planar face from a closed outline (KiCad repeats no closing point)."""
    vectors = [_vec(p) for p in points]
    if len(vectors) < 3:
        raise RpcError(INVALID_PARAMS, "an outline needs at least three points")
    if (vectors[0] - vectors[-1]).Length > 1e-9:
        vectors.append(vectors[0])
    return Part.Face(Part.makePolygon(vectors))


def _hole_tool(hole, thickness):
    """A cylinder or a slot through the board for one drilled hole."""
    width = float(hole["width"])
    height = float(hole["height"])
    centre = FreeCAD.Vector(float(hole["x"]), -float(hole["y"]), -1.0)
    depth = thickness + 2.0
    if abs(width - height) < 1e-6:
        return Part.makeCylinder(width / 2.0, depth, centre)
    # A slot: a stadium along its long side, rotated with the pad.
    radius = min(width, height) / 2.0
    half = (max(width, height) - min(width, height)) / 2.0
    along_x = width >= height
    a = FreeCAD.Vector(-half, 0, 0) if along_x else FreeCAD.Vector(0, -half, 0)
    b = FreeCAD.Vector(half, 0, 0) if along_x else FreeCAD.Vector(0, half, 0)
    box = Part.makeBox(2 * half if along_x else 2 * radius, 2 * radius if along_x else 2 * half, depth)
    box.translate(FreeCAD.Vector(-half if along_x else -radius, -radius if along_x else -half, 0))
    slot = box.fuse([Part.makeCylinder(radius, depth, a), Part.makeCylinder(radius, depth, b)])
    # KiCad's angles turn counter-clockwise on screen (Y down), which is clockwise
    # here with Y up: the same visual turn.
    slot.rotate(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 0, 1), float(hole.get("angle", 0.0)))
    slot.translate(centre)
    return slot


def board_shape(board):
    thickness = float(board["thickness"])
    if thickness <= 0:
        raise RpcError(INVALID_PARAMS, "the board's thickness must be positive")
    outlines = board.get("outlines") or []
    if not outlines:
        raise RpcError(INVALID_PARAMS, "the board has no outline")
    solids = []
    for outline in outlines:
        face = _face(outline["points"])
        for cutout in outline.get("cutouts") or []:
            face = face.cut(_face(cutout["points"]))
        solids.append(face.extrude(FreeCAD.Vector(0, 0, thickness)))
    shape = solids[0] if len(solids) == 1 else solids[0].fuse(solids[1:])
    tools = [_hole_tool(hole, thickness) for hole in board.get("holes") or []]
    if tools:
        shape = shape.cut(tools)
    return shape.removeSplitter() if hasattr(shape, "removeSplitter") else shape


def part_height(footprint):
    """(height in mm, where it came from): the Height field, the name, or unknown."""
    height = float(footprint.get("height") or 0.0)
    if height > 0:
        return height, "field"
    name = footprint.get("footprint", "")
    for pattern, estimate in ESTIMATES:
        match = pattern.search(name)
        if match:
            return estimate(match), "estimate"
    return 0.0, "unknown"


def part_shape(footprint, thickness, height):
    """The courtyard extruded up from the top (or down from the bottom)."""
    face = _face(footprint["courtyard"])
    if footprint.get("back"):
        return face.extrude(FreeCAD.Vector(0, 0, -height))
    face.translate(FreeCAD.Vector(0, 0, thickness))
    return face.extrude(FreeCAD.Vector(0, 0, height))


def _object_name(reference):
    return "Part_" + re.sub(r"[^A-Za-z0-9_]", "_", reference or "unnamed")


def _set_colour(obj, colour):
    if "TriageColour" not in obj.PropertiesList:
        obj.addProperty("App::PropertyColor", "TriageColour", "Triage", "The colour Triage's 3D view draws")
    obj.TriageColour = colour


def _is_connector(footprint):
    return re.search(r"(?i)connector|jack|header|socket|usb|terminal", footprint.get("footprint", "")) is not None


def update(board):
    """Builds (or rebuilds) the board document; returns what the view and checks need."""
    names = FreeCAD.listDocuments()
    doc = FreeCAD.getDocument(DOCUMENT) if DOCUMENT in names else None
    if doc is None:
        doc = FreeCAD.newDocument(DOCUMENT, hidden=True)
        doc.Label = "Board"
    for o in list(doc.Objects):
        doc.removeObject(o.Name)

    thickness = float(board["thickness"])
    pcb = doc.addObject("Part::Feature", "PCB")
    pcb.Label = "Board"
    pcb.Shape = board_shape(board)
    _set_colour(pcb, BOARD_COLOUR)

    parts = []
    for footprint in board.get("footprints") or []:
        height, source = part_height(footprint)
        entry = {
            "reference": footprint.get("reference", ""),
            "footprint": footprint.get("footprint", ""),
            "uuid": footprint.get("uuid", ""),
            "height": height,
            "heightSource": source,
            "back": bool(footprint.get("back")),
            "object": None,
        }
        if height > TALL_TOLERANCE and footprint.get("courtyard"):
            obj = doc.addObject("Part::Feature", _object_name(entry["reference"]))
            obj.Label = entry["reference"] or obj.Name
            obj.Shape = part_shape(footprint, thickness, height)
            _set_colour(obj, CONNECTOR_COLOUR if _is_connector(footprint) else PART_COLOUR)
            entry["object"] = obj.Name
        parts.append(entry)

    doc.recompute()
    box = pcb.Shape.BoundBox
    holes = board.get("holes") or []
    result = {
        "doc": doc.Name,
        "thickness": thickness,
        "box": [box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax],
        "parts": parts,
        "holes": len(holes),
        "mountingHoles": [
            {"x": float(h["x"]), "y": -float(h["y"]), "diameter": min(float(h["width"]), float(h["height"])), "footprint": h.get("footprint", "")}
            for h in holes
            if not h.get("plated") and min(float(h["width"]), float(h["height"])) >= 2.5
        ],
        # The app sends camelCase; the KiCad engine's --dump writes proto field names.
        "outlineOk": bool(board.get("outlineOk", board.get("outline_ok", True))),
        "objects": documents.tree(doc),
    }
    LAST.clear()
    LAST.update(result)
    return result


def _colour_of(obj):
    value = getattr(obj, "TriageColour", None)
    if isinstance(value, tuple) and len(value) >= 3:
        return [float(value[0]), float(value[1]), float(value[2])]
    return None


# Used by documents.mesh_objects for objects that carry a Triage colour.
documents.COLOUR_HOOKS.append(_colour_of)
