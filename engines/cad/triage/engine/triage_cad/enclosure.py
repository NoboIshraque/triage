# A printable enclosure generated from the circuit board (ROADMAP P2-4): a base with
# walls, a floor and screw bosses under the board's mounting holes, cutouts in the
# walls where connectors reach the board's edge, and a lid with a lip that fits
# inside the walls. A FreeCAD feature (Part::FeaturePython) whose parameters are
# ordinary properties, so Triage's properties panel edits them and FreeCAD recomputes
# the shape; the board's outline, holes and connectors are copied into it, so the
# saved document recomputes without the board. Stock FreeCAD opens the file and shows
# the last shape it was saved with (it has no Triage module to recompute it).
#
# Coordinates as in board.py: the board's bottom face is z = 0, X right, Y up (mm).
import FreeCAD
import Part

TYPE = "Triage::Enclosure"

# name, type, default, group, documentation
PARAMETERS = [
    ("WallThickness", "App::PropertyLength", 2.0, "Enclosure", "Walls, floor and lid"),
    ("Clearance", "App::PropertyLength", 1.0, "Enclosure", "Gap between the board's edge and the walls"),
    ("StandoffHeight", "App::PropertyLength", 6.0, "Enclosure", "Space under the board (the bosses' height)"),
    ("InnerHeight", "App::PropertyLength", 0.0, "Enclosure", "Space above the board, up to the lid (set from the tallest part when the enclosure is made; a taller part then shows as a problem)"),
    ("CornerRadius", "App::PropertyLength", 2.0, "Enclosure", "Rounding of the outer vertical edges"),
    ("BossDiameter", "App::PropertyLength", 6.0, "Bosses", "Outer diameter of a screw boss"),
    ("ScrewHoleDiameter", "App::PropertyLength", 2.5, "Bosses", "Pilot hole for an M3 screw"),
    ("CutoutMargin", "App::PropertyLength", 1.2, "Cutouts", "Extra room around a connector's opening"),
    ("LidLip", "App::PropertyLength", 2.0, "Lid", "Depth of the lip that holds the lid in the walls"),
    ("LidTolerance", "App::PropertyLength", 0.25, "Lid", "Gap between the lip and the walls, for printing"),
    ("ExplodeLid", "App::PropertyLength", 0.0, "Lid", "Lifts the lid in the view (0: closed)"),
]

# Copied from the board (board.update) so the document recomputes on its own.
BOARD_PROPERTIES = [
    ("BoardBox", "App::PropertyVectorList", "Board", "The board's outline box: (xmin, ymin, 0), (xmax, ymax, thickness)"),
    ("MountingHoles", "App::PropertyVectorList", "Board", "Mounting holes: (x, y, diameter)"),
    ("Connectors", "App::PropertyStringList", "Board", "Connectors at the edge: reference;side;min;max;zmin;zmax"),
    ("PartsHeight", "App::PropertyLength", "Board", "The tallest part above the board"),
]


def _value(obj, name):
    value = getattr(obj, name)
    return float(value.Value) if hasattr(value, "Value") else float(value)


def _rounded_box(x0, y0, z0, x1, y1, z1, radius):
    box = Part.makeBox(x1 - x0, y1 - y0, z1 - z0, FreeCAD.Vector(x0, y0, z0))
    radius = min(radius, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01)
    if radius <= 0.01:
        return box
    vertical = [e for e in box.Edges if abs(e.Vertexes[0].Point.z - e.Vertexes[1].Point.z) > 1e-6]
    return box.makeFillet(radius, vertical)


class Enclosure:
    """The feature's Python side (its 'Proxy'); FreeCAD saves its module and class."""

    def __init__(self, obj):
        obj.Proxy = self
        Enclosure.ensure_properties(obj)

    @staticmethod
    def ensure_properties(obj):
        for name, kind, default, group, doc in PARAMETERS:
            if name not in obj.PropertiesList:
                obj.addProperty(kind, name, group, doc)
                setattr(obj, name, default)
        for name, kind, group, doc in BOARD_PROPERTIES:
            if name not in obj.PropertiesList:
                obj.addProperty(kind, name, group, doc)
        if "TriageColour" not in obj.PropertiesList:
            obj.addProperty("App::PropertyColor", "TriageColour", "Triage", "The colour Triage's 3D view draws")
            obj.TriageColour = (0.85, 0.86, 0.88)
        for name in ("BoardBox", "MountingHoles", "Connectors", "PartsHeight"):
            obj.setEditorMode(name, 1)  # read-only: they follow the board

    def onDocumentRestored(self, obj):
        Enclosure.ensure_properties(obj)

    def dumps(self):
        return None

    def loads(self, state):
        return None

    def execute(self, obj):
        obj.Shape = build(obj)


def cavity(obj):
    """The inside of the walls: (x0, y0, z0, x1, y1, z1)."""
    box = obj.BoardBox
    if len(box) != 2:
        raise ValueError("the enclosure has no board yet (board.update, then enclosure.fromBoard)")
    clearance = _value(obj, "Clearance")
    x0, y0 = box[0].x - clearance, box[0].y - clearance
    x1, y1 = box[1].x + clearance, box[1].y + clearance
    thickness = box[1].z
    z0 = -_value(obj, "StandoffHeight")
    z1 = thickness + _value(obj, "InnerHeight")
    return x0, y0, z0, x1, y1, z1


def build(obj):
    wall = _value(obj, "WallThickness")
    if wall <= 0:
        raise ValueError("WallThickness must be positive")
    x0, y0, z0, x1, y1, z1 = cavity(obj)
    radius = _value(obj, "CornerRadius")

    # The base: an open box from the floor's underside up to the cavity's top.
    outer = _rounded_box(x0 - wall, y0 - wall, z0 - wall, x1 + wall, y1 + wall, z1, radius)
    inner = _rounded_box(x0, y0, z0, x1, y1, z1 + 1.0, max(0.0, radius - wall))
    base = outer.cut(inner)

    # Bosses under the mounting holes, from the floor to the board's underside.
    boss_r = _value(obj, "BossDiameter") / 2.0
    hole_r = _value(obj, "ScrewHoleDiameter") / 2.0
    bosses, holes = [], []
    for hole in obj.MountingHoles:
        bosses.append(Part.makeCylinder(boss_r, -z0 + 0.01, FreeCAD.Vector(hole.x, hole.y, z0 - 0.01)))
        holes.append(Part.makeCylinder(hole_r, -z0 + wall, FreeCAD.Vector(hole.x, hole.y, z0 - wall + 0.6)))
    if bosses:
        base = base.fuse(bosses)
    if holes:
        base = base.cut(holes)

    # Openings for connectors at the board's edge, through the wall they face.
    margin = _value(obj, "CutoutMargin")
    cuts = []
    for entry in obj.Connectors:
        _, side, low, high, zlow, zhigh = entry.split(";")
        low, high, zlow, zhigh = float(low) - margin, float(high) + margin, float(zlow) - margin, float(zhigh) + margin
        depth = wall + 2.0
        if side == "left":
            cuts.append(Part.makeBox(depth, high - low, zhigh - zlow, FreeCAD.Vector(x0 - wall - 1.0, low, zlow)))
        elif side == "right":
            cuts.append(Part.makeBox(depth, high - low, zhigh - zlow, FreeCAD.Vector(x1 - 1.0, low, zlow)))
        elif side == "bottom":
            cuts.append(Part.makeBox(high - low, depth, zhigh - zlow, FreeCAD.Vector(low, y0 - wall - 1.0, zlow)))
        elif side == "top":
            cuts.append(Part.makeBox(high - low, depth, zhigh - zlow, FreeCAD.Vector(low, y1 - 1.0, zlow)))
    if cuts:
        base = base.cut(cuts)

    # The lid: a plate on the walls with a lip that fits inside them.
    tolerance = _value(obj, "LidTolerance")
    lip = _value(obj, "LidLip")
    lift = _value(obj, "ExplodeLid")
    plate = _rounded_box(x0 - wall, y0 - wall, z1, x1 + wall, y1 + wall, z1 + wall, radius)
    lid = plate
    if lip > 0:
        rim_outer = _rounded_box(x0 + tolerance, y0 + tolerance, z1 - lip, x1 - tolerance, y1 - tolerance, z1 + 0.01, max(0.0, radius - wall))
        rim_inner = _rounded_box(x0 + tolerance + wall, y0 + tolerance + wall, z1 - lip - 1.0, x1 - tolerance - wall, y1 - tolerance - wall, z1 + 0.02, 0.0)
        lid = plate.fuse(rim_outer.cut(rim_inner))
    if lift:
        lid.translate(FreeCAD.Vector(0, 0, lift))

    base = base.removeSplitter()
    lid = lid.removeSplitter()
    return Part.makeCompound([base, lid])


def board_inputs(board_doc, board):
    """What the enclosure copies from the board: its box, mounting holes and the
    connectors that reach its edge (board.update's result and the board document)."""
    pcb = board_doc.getObject("PCB")
    box = pcb.Shape.BoundBox
    thickness = float(board["thickness"])
    tallest = 0.0
    connectors = []
    edge = 1.0  # a connector that reaches the board's edge (or overhangs it) gets an opening
    for part in board["parts"]:
        if part["back"] or not part["object"]:
            continue
        tallest = max(tallest, float(part["height"]))
        if not _looks_like_connector(part["footprint"]):
            continue
        shape = board_doc.getObject(part["object"]).Shape.BoundBox
        sides = {
            "left": shape.XMin - box.XMin,
            "right": box.XMax - shape.XMax,
            "bottom": shape.YMin - box.YMin,
            "top": box.YMax - shape.YMax,
        }
        side, distance = min(sides.items(), key=lambda item: item[1])
        if distance > edge:
            continue
        low, high = (shape.YMin, shape.YMax) if side in ("left", "right") else (shape.XMin, shape.XMax)
        connectors.append(f"{part['reference']};{side};{low:.3f};{high:.3f};{shape.ZMin:.3f};{shape.ZMax:.3f}")
    return {
        "BoardBox": [FreeCAD.Vector(box.XMin, box.YMin, 0), FreeCAD.Vector(box.XMax, box.YMax, thickness)],
        "MountingHoles": [FreeCAD.Vector(h["x"], h["y"], h["diameter"]) for h in board["mountingHoles"]],
        "Connectors": connectors,
        "PartsHeight": tallest,
    }


def _looks_like_connector(name):
    lowered = name.lower()
    return any(word in lowered for word in ("jack", "connector", "usb", "terminal", "barrel", "header", "socket"))


def find(doc):
    """The document's enclosure feature, if it has one."""
    for obj in doc.Objects:
        if getattr(obj, "Proxy", None).__class__.__name__ == "Enclosure":
            return obj
    return None


TOP_CLEARANCE = 3.0  # mm above the tallest part, for a new enclosure


def create(doc, inputs, name="Enclosure"):
    obj = doc.addObject("Part::FeaturePython", name)
    Enclosure(obj)
    obj.Label = "Enclosure"
    update_from_board(obj, inputs)
    obj.InnerHeight = float(inputs["PartsHeight"]) + TOP_CLEARANCE
    return obj


def update_from_board(obj, inputs):
    """Copies the board's inputs in, unless they are already there (keeps undo tidy)."""
    changed = False
    for name, value in inputs.items():
        current = getattr(obj, name)
        same = (
            abs(float(getattr(current, "Value", current)) - float(value)) < 1e-9
            if name == "PartsHeight"
            else list(current) == list(value)
        )
        if not same:
            setattr(obj, name, value)
            changed = True
    return changed
