# Generates the Smart Fan's FreeCAD documents (examples/smart-fan/mechanical/) with
# FreeCAD itself, so stock FreeCAD opens them (CLAUDE.md: files are the source of
# truth). Run through the CAD engine's FreeCADCmd by smart-fan-freecad.mjs:
#
#   node scripts/examples/smart-fan-freecad.mjs
#
# fan.FCStd: the fan's rotor, a PartDesign body on the motor's 2 mm shaft: a hub,
# one pitched blade and a polar pattern of five. Its sizes are named sketch
# constraints (HubRadius, BladeLength …), so Triage's properties panel and the
# simulation's mechanics (P3-4) can read them.
import os
import sys

import FreeCAD as App
import Part
import Sketcher

OUT = os.environ["TRIAGE_EXAMPLE_OUT"]

HUB_RADIUS = 8.0
HUB_HEIGHT = 12.0
SHAFT_RADIUS = 1.05  # a 2 mm motor shaft, press fit
BLADE_ROOT = 6.0  # starts inside the hub, so the blade fuses with it
BLADE_TIP = 45.0
BLADE_WIDTH = 18.0
BLADE_THICKNESS = 1.6
BLADE_PITCH = 25.0  # degrees
BLADES = 5


def origin(body, role):
    for feature in body.Origin.OriginFeatures:
        if feature.Role == role:
            return feature
    raise LookupError(role)


def sketch(body, name, plane, offset=None):
    sk = body.newObject("Sketcher::SketchObject", name)
    sk.AttachmentSupport = [(origin(body, plane), "")]
    sk.MapMode = "FlatFace"
    if offset is not None:
        sk.AttachmentOffset = offset
    return sk


def circle(sk, radius, name):
    index = sk.addGeometry(Part.Circle(App.Vector(0, 0, 0), App.Vector(0, 0, 1), radius))
    sk.addConstraint(Sketcher.Constraint("Coincident", index, 3, -1, 1))
    constraint = sk.addConstraint(Sketcher.Constraint("Radius", index, radius))
    sk.renameConstraint(constraint, name)


def rectangle(sk, x0, x1, half_width):
    """A rectangle from x0 to x1, centred on the X axis, fully constrained."""
    p = [
        App.Vector(x0, -half_width, 0),
        App.Vector(x1, -half_width, 0),
        App.Vector(x1, half_width, 0),
        App.Vector(x0, half_width, 0),
    ]
    lines = [sk.addGeometry(Part.LineSegment(p[i], p[(i + 1) % 4])) for i in range(4)]
    for i in range(4):
        sk.addConstraint(Sketcher.Constraint("Coincident", lines[i], 2, lines[(i + 1) % 4], 1))
    sk.addConstraint(Sketcher.Constraint("Horizontal", lines[0]))
    sk.addConstraint(Sketcher.Constraint("Horizontal", lines[2]))
    sk.addConstraint(Sketcher.Constraint("Vertical", lines[1]))
    # Symmetric about the X axis (which also keeps the root edge vertical).
    sk.addConstraint(Sketcher.Constraint("Symmetric", lines[0], 1, lines[3], 1, -1))
    c = sk.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, lines[0], 1, x0))
    sk.renameConstraint(c, "BladeRoot")
    c = sk.addConstraint(Sketcher.Constraint("DistanceX", lines[0], 1, lines[0], 2, x1 - x0))
    sk.renameConstraint(c, "BladeLength")
    c = sk.addConstraint(Sketcher.Constraint("DistanceY", lines[1], 1, lines[1], 2, 2 * half_width))
    sk.renameConstraint(c, "BladeWidth")


def fan():
    doc = App.newDocument("Fan")
    doc.Label = "Fan"
    body = doc.addObject("PartDesign::Body", "Rotor")
    body.Label = "Rotor"

    hub_sketch = sketch(body, "HubSketch", "XY_Plane")
    circle(hub_sketch, HUB_RADIUS, "HubRadius")
    hub = body.newObject("PartDesign::Pad", "Hub")
    hub.Profile = hub_sketch
    hub.Length = HUB_HEIGHT

    blade_sketch = sketch(
        body,
        "BladeSketch",
        "XY_Plane",
        App.Placement(App.Vector(0, 0, HUB_HEIGHT / 2), App.Rotation(App.Vector(1, 0, 0), BLADE_PITCH)),
    )
    rectangle(blade_sketch, BLADE_ROOT, BLADE_TIP, BLADE_WIDTH / 2)
    blade = body.newObject("PartDesign::Pad", "Blade")
    blade.Profile = blade_sketch
    blade.Length = BLADE_THICKNESS
    blade.SideType = "Symmetric"

    blades = body.newObject("PartDesign::PolarPattern", "Blades")
    blades.Originals = [blade]
    blades.Axis = (origin(body, "Z_Axis"), [""])
    blades.Angle = 360
    blades.Occurrences = BLADES
    # The pattern must be the body's tip before the next feature builds on it
    # (FreeCAD 1.1 leaves the tip on the blade when the pattern is added by script).
    doc.recompute()
    body.Tip = blades

    shaft_sketch = sketch(body, "ShaftSketch", "XY_Plane")
    circle(shaft_sketch, SHAFT_RADIUS, "ShaftRadius")
    shaft = body.newObject("PartDesign::Pocket", "ShaftHole")
    shaft.Profile = shaft_sketch
    shaft.Type = "ThroughAll"
    shaft.SideType = "Symmetric"

    doc.recompute()
    bad = [o.Name for o in doc.Objects if not o.isValid()]
    if bad:
        raise RuntimeError(f"fan.FCStd: invalid objects {bad}")
    shape = body.Shape
    if body.Tip != shaft or shaft.BaseFeature != blades:
        raise RuntimeError("fan.FCStd: the shaft hole must be cut from the pattern")
    if len(shape.Solids) != 1:
        raise RuntimeError(f"fan.FCStd: the rotor is {len(shape.Solids)} solids, not one")
    path = os.path.join(OUT, "fan.FCStd")
    if os.path.exists(path):
        os.remove(path)  # else FreeCAD keeps the old file as a .FCBak backup
    doc.saveAs(path)
    print(f"fan.FCStd: {len(doc.Objects)} objects, volume {shape.Volume:.0f} mm3, {len(shape.Faces)} faces")
    App.closeDocument(doc.Name)


try:
    fan()
    code = 0
except Exception:
    import traceback

    traceback.print_exc()
    code = 1
sys.stdout.flush()
sys.exit(code)
