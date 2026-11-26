# FreeCAD documents as the CAD engine serves them (ROADMAP P2-2): open, recompute,
# the feature tree, properties, edits with undo, saving and meshes for the 3D view.
# Everything here is FreeCAD's own App layer; Triage only translates to and from
# JSON.
import os

import FreeCAD

try:
    import Part
except ImportError:  # pragma: no cover - the engine always builds Part
    Part = None


class RpcError(Exception):
    """An error the client caused (bad parameters, unknown names)."""

    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


INVALID_PARAMS = -32602
NOT_FOUND = -32001
FREECAD_ERROR = -32002


def document(name):
    doc = FreeCAD.getDocument(name) if name in FreeCAD.listDocuments() else None
    if doc is None:
        raise RpcError(NOT_FOUND, f"no open document named {name!r}")
    return doc


def obj(doc, name):
    found = doc.getObject(name)
    if found is None:
        raise RpcError(NOT_FOUND, f"no object named {name!r} in {doc.Name}")
    return found


def _state(o):
    """FreeCAD's object state (Touched, Invalid, Error …) as a list."""
    try:
        return [s for s in o.State if isinstance(s, str)]
    except Exception:
        return []


def _parent(o):
    for get in ("getParentGeoFeatureGroup", "getParentGroup"):
        try:
            parent = getattr(o, get)()
        except Exception:
            parent = None
        if parent is not None:
            return parent
    return None


def _is_body_feature(o):
    """A feature inside a PartDesign body (the body itself shows its result)."""
    parent = _parent(o)
    return parent is not None and parent.isDerivedFrom("PartDesign::Body")


def _is_origin(o):
    return o.isDerivedFrom("App::Origin") or o.isDerivedFrom("App::DatumElement") or (
        _parent(o) is not None and _parent(o).isDerivedFrom("App::Origin")
    )


def _has_shape(o):
    shape = getattr(o, "Shape", None)
    return shape is not None and hasattr(shape, "isNull") and not shape.isNull()


def shown(o):
    """Whether the 3D view draws this object: visible shapes that aren't a body's
    intermediate features or origin planes (FreeCAD's GUI hides those too)."""
    if not getattr(o, "Visibility", True) or _is_origin(o) or not _has_shape(o):
        return False
    if _is_body_feature(o):
        return False
    return True


def tree(doc):
    """The feature tree: every object with its parent, children and state."""
    items = []
    for o in doc.Objects:
        parent = _parent(o)
        children = []
        group = getattr(o, "Group", None)
        if isinstance(group, list):
            children = [child.Name for child in group]
        items.append(
            {
                "name": o.Name,
                "label": o.Label,
                "type": o.TypeId,
                "parent": parent.Name if parent is not None else None,
                "children": children,
                "state": _state(o),
                "visible": bool(getattr(o, "Visibility", True)),
                "shown": shown(o),
                "tip": o.Tip.Name if getattr(o, "Tip", None) is not None and hasattr(o.Tip, "Name") else None,
            }
        )
    return items


def summary(doc):
    return {
        "name": doc.Name,
        "label": doc.Label,
        "path": doc.FileName or None,
        "objects": tree(doc),
        "canUndo": doc.UndoCount > 0,
        "canRedo": doc.RedoCount > 0,
    }


def open_document(path):
    if not isinstance(path, str) or not path:
        raise RpcError(INVALID_PARAMS, "path must name a .FCStd file")
    path = os.path.abspath(path)
    for name in FreeCAD.listDocuments():
        doc = FreeCAD.getDocument(name)
        if doc.FileName and os.path.normcase(os.path.abspath(doc.FileName)) == os.path.normcase(path):
            return doc
    if not os.path.isfile(path):
        raise RpcError(NOT_FOUND, f"{path} does not exist")
    doc = FreeCAD.openDocument(path, True)  # hidden: no GUI to show it in
    doc.UndoMode = 1
    return doc


def recompute(doc, force=False):
    """Recomputes what changed, or with force every object (all touched first)."""
    if force:
        for o in doc.Objects:
            o.touch()
    count = doc.recompute()
    errors = []
    for o in doc.Objects:
        state = _state(o)
        if "Invalid" in state or "Error" in state or not o.isValid():
            errors.append({"object": o.Name, "label": o.Label, "message": o.getStatusString()})
    return {"recomputed": count, "errors": errors}


# --- Properties -------------------------------------------------------------------


def _vector(v):
    return [v.x, v.y, v.z]


def _value(o, name, kind):
    """A property's value as JSON, or None for values the panel can't show."""
    value = getattr(o, name)
    if kind in ("App::PropertyBool",):
        return bool(value)
    if kind in ("App::PropertyInteger", "App::PropertyIntegerConstraint"):
        return int(value)
    if kind in ("App::PropertyFloat", "App::PropertyFloatConstraint", "App::PropertyPrecision"):
        return float(value)
    if hasattr(value, "Value") and hasattr(value, "Unit"):  # a Quantity
        # Value is in FreeCAD's internal units (mm, s, kg …); text in the user's.
        return {"value": value.Value, "text": value.UserString}
    if kind == "App::PropertyEnumeration":
        return {"value": value, "options": list(o.getEnumerationsOfProperty(name) or [])}
    if kind in ("App::PropertyString", "App::PropertyFile", "App::PropertyFileIncluded", "App::PropertyPath"):
        return str(value)
    if kind == "App::PropertyVector" or kind == "App::PropertyVectorDistance":
        return _vector(value)
    if kind == "App::PropertyPlacement":
        axis = value.Rotation.Axis
        return {
            "position": _vector(value.Base),
            "axis": [axis.x, axis.y, axis.z],
            "angle": value.Rotation.Angle * 180.0 / 3.141592653589793,
        }
    if kind in ("App::PropertyLink", "App::PropertyLinkChild", "App::PropertyLinkGlobal", "App::PropertyLinkHidden"):
        return value.Name if value is not None else None
    if kind in ("App::PropertyLinkList", "App::PropertyLinkListChild", "App::PropertyLinkListGlobal", "App::PropertyLinkListHidden"):
        return [item.Name for item in value or []]
    if kind in ("App::PropertyLinkSub", "App::PropertyLinkSubChild", "App::PropertyLinkSubGlobal", "App::PropertyLinkSubHidden"):
        if not value:
            return None
        return {"object": value[0].Name, "subs": list(value[1])}
    if kind == "App::PropertyStringList":
        return list(value)
    return None


def properties(o):
    items = []
    for name in o.PropertiesList:
        kind = o.getTypeIdOfProperty(name)
        mode = o.getEditorMode(name) or []
        try:
            value = _value(o, name, kind)
        except Exception:
            value = None
        items.append(
            {
                "name": name,
                "type": kind,
                "group": o.getGroupOfProperty(name),
                "doc": o.getDocumentationOfProperty(name),
                "readOnly": "ReadOnly" in mode or value is None,
                "hidden": "Hidden" in mode,
                "value": value,
            }
        )
    return items


def _quantity(value, current):
    if isinstance(value, dict):
        value = value.get("text", value.get("value"))
    if isinstance(value, (int, float)):
        return FreeCAD.Units.Quantity(float(value), current.Unit)
    if isinstance(value, str):
        quantity = FreeCAD.Units.Quantity(value)
        return quantity
    raise RpcError(INVALID_PARAMS, f"expected a number or a quantity, got {value!r}")


def set_property(doc, o, name, value):
    if name not in o.PropertiesList:
        raise RpcError(NOT_FOUND, f"{o.Name} has no property {name!r}")
    kind = o.getTypeIdOfProperty(name)
    if "ReadOnly" in (o.getEditorMode(name) or []):
        raise RpcError(INVALID_PARAMS, f"{o.Name}.{name} is read-only")
    current = getattr(o, name)
    doc.openTransaction(f"Set {o.Label}.{name}")
    try:
        if hasattr(current, "Value") and hasattr(current, "Unit"):
            setattr(o, name, _quantity(value, current))
        elif kind == "App::PropertyBool":
            setattr(o, name, bool(value))
        elif kind in ("App::PropertyInteger", "App::PropertyIntegerConstraint"):
            setattr(o, name, int(value))
        elif kind in ("App::PropertyFloat", "App::PropertyFloatConstraint", "App::PropertyPrecision"):
            setattr(o, name, float(value))
        elif kind == "App::PropertyEnumeration":
            setattr(o, name, str(value.get("value") if isinstance(value, dict) else value))
        elif kind in ("App::PropertyString",):
            setattr(o, name, str(value))
        elif kind in ("App::PropertyVector", "App::PropertyVectorDistance"):
            setattr(o, name, FreeCAD.Vector(*[float(c) for c in value]))
        elif kind == "App::PropertyPlacement":
            setattr(
                o,
                name,
                FreeCAD.Placement(
                    FreeCAD.Vector(*[float(c) for c in value["position"]]),
                    FreeCAD.Rotation(FreeCAD.Vector(*[float(c) for c in value["axis"]]), float(value["angle"])),
                ),
            )
        else:
            raise RpcError(INVALID_PARAMS, f"{o.Name}.{name} ({kind}) can't be set over RPC yet")
    except RpcError:
        doc.abortTransaction()
        raise
    except Exception as error:
        doc.abortTransaction()
        raise RpcError(INVALID_PARAMS, f"{o.Name}.{name}: {error}") from error
    doc.commitTransaction()


# --- Meshes -----------------------------------------------------------------------


def _colour(o):
    """A shape's colour, if the document records one (ShapeMaterial or a legacy
    ShapeColor property); else None and the view picks its default."""
    for name in ("ShapeColor",):
        value = getattr(o, name, None)
        if isinstance(value, tuple) and len(value) >= 3:
            return [float(value[0]), float(value[1]), float(value[2])]
    return None


def mesh_objects(doc, names=None):
    """The objects the view draws (or the named ones), with their meta data."""
    objects = [obj(doc, name) for name in names] if names else [o for o in doc.Objects if shown(o)]
    result = []
    for o in objects:
        if not _has_shape(o):
            continue
        box = o.Shape.BoundBox
        result.append(
            (
                o,
                {
                    "object": o.Name,
                    "label": o.Label,
                    "type": o.TypeId,
                    "box": [box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax],
                    "faces": len(o.Shape.Faces),
                    "edges": len(o.Shape.Edges),
                    "volume": o.Shape.Volume if o.Shape.Solids else 0.0,
                    "colour": _colour(o),
                },
            )
        )
    return result
