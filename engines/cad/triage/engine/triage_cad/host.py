# Triage's CAD engine (ROADMAP P2-2, ADR 0002): FreeCAD's App layer behind a
# JSON-RPC server, in FreeCADCmd. The broker (app/src/vs/triage/node/
# cadEngineBrokerMain.ts) listens on a local endpoint and starts
#
#   FreeCADCmd <stage>/triage/triage_cad_engine.py --pass --connect <endpoint>
#
# The engine connects, says Hello ("triage-cad-engine <FreeCAD version> <pid>") and
# answers one request at a time:
#
#   broker -> engine  0x30 Request   JSON-RPC 2.0 request (UTF-8)
#   engine -> broker  0x32 Mesh      binary mesh chunks for that request (tessellation.py)
#   engine -> broker  0x31 Response  JSON-RPC 2.0 response (UTF-8), after its chunks
#   broker -> engine  0x02 Ping      answered with 0x03 Pong (same payload)
#
# Methods: engine.info, document.open, document.new, document.close, document.list,
# document.tree, document.recompute, document.save, document.undo, document.redo,
# document.tessellate, object.properties, object.setProperty, board.update,
# enclosure.fromBoard, enclosure.export, checks.fit.
import json
import os
import sys
import time
import traceback

import FreeCAD

from . import board, checks, documents, enclosure
from .documents import INVALID_PARAMS, RpcError
from .tessellation import pack_mesh, mesh_shape
from .transport import ERROR, HELLO, PING, PONG, Closed, Connection

REQUEST = 0x30
RESPONSE = 0x31
MESH = 0x32

NAME = "triage-cad-engine"
DEFAULT_DEFLECTION = 0.1  # mm: the 3D view's default chordal deviation


def _version():
    return ".".join(FreeCAD.Version()[:3])


def _param(params, name, kind=None, default=None, required=True):
    if not isinstance(params, dict) or name not in params:
        if required:
            raise RpcError(INVALID_PARAMS, f"missing parameter {name!r}")
        return default
    value = params[name]
    if kind is not None and not isinstance(value, kind):
        raise RpcError(INVALID_PARAMS, f"parameter {name!r} has the wrong type")
    return value


class Engine:
    def __init__(self, connection):
        self.connection = connection

    # --- methods ----------------------------------------------------------------

    def engine_info(self, params, request_id):
        info = {
            "name": NAME,
            "freecad": _version(),
            "python": sys.version.split()[0],
            "modules": sorted(m for m in ("Part", "Sketcher", "PartDesign", "Import", "Mesh", "Measure") if _importable(m)),
        }
        try:
            import Part

            info["occt"] = Part.OCC_VERSION
        except Exception:
            pass
        return info

    def document_open(self, params, request_id):
        doc = documents.open_document(_param(params, "path", str))
        result = documents.summary(doc)
        if _param(params, "recompute", bool, False, required=False):
            result["recompute"] = documents.recompute(doc)
            result["objects"] = documents.tree(doc)
        return result

    def document_new(self, params, request_id):
        doc = FreeCAD.newDocument(_param(params, "name", str, "Unnamed", required=False), hidden=True)
        doc.UndoMode = 1
        return documents.summary(doc)

    def document_close(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        FreeCAD.closeDocument(doc.Name)
        return {"closed": True}

    def document_list(self, params, request_id):
        return [
            {"name": name, "label": doc.Label, "path": doc.FileName or None}
            for name, doc in FreeCAD.listDocuments().items()
        ]

    def document_tree(self, params, request_id):
        return documents.summary(documents.document(_param(params, "doc", str)))

    def document_recompute(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        started = time.perf_counter()
        result = documents.recompute(doc, _param(params, "force", bool, False, required=False))
        result["milliseconds"] = round((time.perf_counter() - started) * 1000, 1)
        result["objects"] = documents.tree(doc)
        return result

    def document_save(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        path = _param(params, "path", str, None, required=False)
        if path:
            doc.saveAs(os.path.abspath(path))
        elif doc.FileName:
            doc.save()
        else:
            raise RpcError(INVALID_PARAMS, "a new document needs a path to be saved")
        return {"path": doc.FileName}

    def document_undo(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        if doc.UndoCount > 0:
            doc.undo()
            doc.recompute()
        return documents.summary(doc)

    def document_redo(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        if doc.RedoCount > 0:
            doc.redo()
            doc.recompute()
        return documents.summary(doc)

    def document_tessellate(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        names = _param(params, "objects", list, None, required=False)
        deflection = float(_param(params, "deflection", (int, float), DEFAULT_DEFLECTION, required=False))
        if deflection <= 0:
            raise RpcError(INVALID_PARAMS, "deflection must be positive")
        started = time.perf_counter()
        meshes = []
        for index, (o, meta) in enumerate(documents.mesh_objects(doc, names)):
            mesh = mesh_shape(o.Shape, deflection)
            meta["vertices"] = len(mesh["positions"]) // 3
            meta["triangles"] = len(mesh["indices"]) // 3
            self.connection.send(MESH, *pack_mesh(request_id, index, mesh))
            meshes.append(meta)
        return {
            "deflection": deflection,
            "meshes": meshes,
            "milliseconds": round((time.perf_counter() - started) * 1000, 1),
        }

    def object_properties(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        o = documents.obj(doc, _param(params, "object", str))
        return {"object": o.Name, "label": o.Label, "type": o.TypeId, "properties": documents.properties(o)}

    def object_set_property(self, params, request_id):
        doc = documents.document(_param(params, "doc", str))
        o = documents.obj(doc, _param(params, "object", str))
        documents.set_property(doc, o, _param(params, "property", str), _param(params, "value"))
        result = {"object": o.Name}
        if _param(params, "recompute", bool, True, required=False):
            result["recompute"] = documents.recompute(doc)
        result["objects"] = documents.tree(doc)
        return result

    def board_update(self, params, request_id):
        """Builds the board document from the KiCad engine's GetBoard3D (as JSON)."""
        return board.update(_param(params, "board", dict))

    def enclosure_from_board(self, params, request_id):
        """Creates or updates the enclosure in a document from the last board.update."""
        doc = documents.document(_param(params, "doc", str))
        if not board.LAST:
            raise RpcError(INVALID_PARAMS, "no board yet: call board.update first")
        board_doc = documents.document(board.LAST["doc"])
        feature = enclosure.find(doc)
        if feature is None:
            doc.openTransaction("Enclosure from board")
            feature = enclosure.create(doc, enclosure.board_inputs(board_doc, board.LAST))
            doc.commitTransaction()
            changed = True
        else:
            doc.openTransaction("Enclosure follows the board")
            changed = enclosure.update_from_board(feature, enclosure.board_inputs(board_doc, board.LAST))
            doc.commitTransaction()
        result = documents.recompute(doc) if changed else {"recomputed": 0, "errors": []}
        return {
            "object": feature.Name,
            "changed": changed,
            "recompute": result,
            "solids": [_solid_info(s) for s in feature.Shape.Solids],
            "objects": documents.tree(doc),
        }

    def enclosure_export(self, params, request_id):
        """Writes the enclosure's parts as STL files for printing (base.stl, lid.stl)."""
        doc = documents.document(_param(params, "doc", str))
        folder = os.path.abspath(_param(params, "folder", str))
        feature = enclosure.find(doc)
        if feature is None:
            raise RpcError(documents.NOT_FOUND, f"{doc.Name} has no enclosure")
        os.makedirs(folder, exist_ok=True)
        files = []
        for name, solid in zip(("base", "lid"), feature.Shape.Solids):
            path = os.path.join(folder, f"{name}.stl")
            solid.exportStl(path)
            files.append({"path": path, **_solid_info(solid)})
        return {"files": files}

    def checks_fit(self, params, request_id):
        """Interference and clearance between the drawn solids of the given documents."""
        names = _param(params, "docs", list)
        clearance = float(_param(params, "minClearance", (int, float), 1.0, required=False))
        started = time.perf_counter()
        result = checks.fit(names, clearance)
        result["milliseconds"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    METHODS = {
        "engine.info": engine_info,
        "document.open": document_open,
        "document.new": document_new,
        "document.close": document_close,
        "document.list": document_list,
        "document.tree": document_tree,
        "document.recompute": document_recompute,
        "document.save": document_save,
        "document.undo": document_undo,
        "document.redo": document_redo,
        "document.tessellate": document_tessellate,
        "object.properties": object_properties,
        "object.setProperty": object_set_property,
        "board.update": board_update,
        "enclosure.fromBoard": enclosure_from_board,
        "enclosure.export": enclosure_export,
        "checks.fit": checks_fit,
    }

    # --- the loop ---------------------------------------------------------------

    def handle(self, payload):
        try:
            request = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {error}"}}
        request_id = request.get("id") if isinstance(request, dict) else None
        if not isinstance(request, dict) or not isinstance(request.get("method"), str) or not isinstance(request_id, int):
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "invalid request (needs an integer id and a method)"}}
        method = self.METHODS.get(request["method"])
        if method is None:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"unknown method {request['method']!r}"}}
        try:
            result = method(self, request.get("params") or {}, request_id)
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcError as error:
            response = {"code": error.code, "message": str(error)}
            if error.data is not None:
                response["data"] = error.data
            return {"jsonrpc": "2.0", "id": request_id, "error": response}
        except Closed:
            raise
        except Exception as error:  # FreeCAD and OpenCASCADE errors
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": documents.FREECAD_ERROR,
                    "message": f"{type(error).__name__}: {error}",
                    "data": traceback.format_exc()[-2000:],
                },
            }

    def serve(self):
        self.connection.send_text(HELLO, f"{NAME} {_version()} {os.getpid()}")
        while True:
            frame_type, payload = self.connection.read_frame()
            if frame_type == PING:
                self.connection.send(PONG, payload)
            elif frame_type == REQUEST:
                response = self.handle(payload)
                self.connection.send(RESPONSE, json.dumps(response, allow_nan=False).encode("utf-8"))
            else:
                self.connection.send_text(ERROR, f"unknown frame type {frame_type}")


def _solid_info(solid):
    """What makes a solid printable: valid, closed, and how big."""
    box = solid.BoundBox
    return {
        "valid": solid.isValid(),
        "closed": all(shell.isClosed() for shell in solid.Shells),
        "volume": solid.Volume,
        "size": [box.XLength, box.YLength, box.ZLength],
    }


def _importable(module):
    try:
        __import__(module)
        return True
    except Exception:
        return False


def endpoint_from_argv(argv):
    """The endpoint after --connect (FreeCADCmd hands everything after --pass on)."""
    for index, arg in enumerate(argv):
        if arg == "--connect" and index + 1 < len(argv):
            return argv[index + 1]
        if arg.startswith("--connect="):
            return arg.split("=", 1)[1]
    return os.environ.get("TRIAGE_ENGINE_CONNECT")


def main(argv=None):
    endpoint = endpoint_from_argv(sys.argv if argv is None else argv)
    if not endpoint:
        sys.stderr.write("triage-cad-engine: --connect <endpoint> is missing\n")
        return 2
    connection = Connection(endpoint)
    try:
        Engine(connection).serve()
    except Closed:
        return 0
    finally:
        connection.close()
    return 0
