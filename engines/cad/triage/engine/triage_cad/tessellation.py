# Shapes as triangle meshes for Triage's 3D view (ROADMAP P2-2, P2-3).
#
# One binary chunk per object ("TCM1", little endian, every field 4 bytes):
#
#   u32 request id, u32 magic 0x314d4354 ("TCM1"), u32 object index (in the
#   response's `meshes` list), u32 vertex count V, u32 triangle count T, u32 face
#   count F, u32 edge count E, u32 edge point count P,
#   f32 positions[3V], u32 indices[3T],
#   u32 faceStart[F+1]   triangles of B-rep face i are faceStart[i] … faceStart[i+1]-1
#   u32 edgeStart[E+1]   points of edge i are edgeStart[i] … edgeStart[i+1]-1
#   f32 edgePoints[3P]
#
# Vertices are not shared between faces, so a renderer that smooths normals per
# face keeps the edges between faces sharp. Face and edge indices name FreeCAD's
# sub-elements ("Face1" is face 0), which selections and checks use.
import struct
from array import array

MAGIC = 0x314D4354
_HEADER = struct.Struct("<8I")


def _f32(values):
    return array("f", values)


def _u32(values):
    return array("I", values)


def mesh_shape(shape, deflection):
    """Triangles per face and polylines per edge of a shape, with counts."""
    positions = _f32([])
    indices = _u32([])
    face_start = _u32([0])
    for face in shape.Faces:
        points, triangles = face.tessellate(deflection)
        base = len(positions) // 3
        for point in points:
            positions.extend((point.x, point.y, point.z))
        for a, b, c in triangles:
            indices.extend((base + a, base + b, base + c))
        face_start.append(len(indices) // 3)
    edge_start = _u32([0])
    edge_points = _f32([])
    for edge in shape.Edges:
        try:
            points = edge.discretize(Deflection=deflection)
        except Exception:
            points = []
        for point in points:
            edge_points.extend((point.x, point.y, point.z))
        edge_start.append(len(edge_points) // 3)
    return {
        "positions": positions,
        "indices": indices,
        "faceStart": face_start,
        "edgeStart": edge_start,
        "edgePoints": edge_points,
    }


def pack_mesh(request_id, index, mesh):
    """The binary chunk for one object's mesh (see the top of this file)."""
    header = _HEADER.pack(
        request_id,
        MAGIC,
        index,
        len(mesh["positions"]) // 3,
        len(mesh["indices"]) // 3,
        len(mesh["faceStart"]) - 1,
        len(mesh["edgeStart"]) - 1,
        len(mesh["edgePoints"]) // 3,
    )
    return [
        header,
        mesh["positions"].tobytes(),
        mesh["indices"].tobytes(),
        mesh["faceStart"].tobytes(),
        mesh["edgeStart"].tobytes(),
        mesh["edgePoints"].tobytes(),
    ]
