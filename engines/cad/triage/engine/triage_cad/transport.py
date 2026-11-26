# The engine connection (ROADMAP P0-4, PLAN §4.2) from inside FreeCAD's Python:
# frames over a Unix socket (Linux, macOS) or a named pipe (Windows), the broker
# listening, the engine connecting.
#
#   u32 little-endian length of (type + payload), u8 type, payload
#
# The same layout as engines/hello/include/triage/hello/protocol.hpp and
# app/src/vs/triage/common/engineProtocol.ts.
import os
import socket
import struct

HELLO = 0x01
PING = 0x02
PONG = 0x03
ERROR = 0x7F

MAX_FRAME_BODY = 64 * 1024 * 1024
_HEADER = struct.Struct("<IB")


class Closed(Exception):
    """The broker went away."""


class Connection:
    """One blocking connection to the broker. The engine answers one request at a
    time, so a single thread reads and writes."""

    def __init__(self, endpoint):
        if os.name == "nt":
            # A named pipe opened as a file; requests and answers alternate, so a
            # synchronous handle is enough.
            self._pipe = open(endpoint, "r+b", buffering=0)
            self._socket = None
        else:
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket.connect(endpoint)
            self._pipe = None

    def close(self):
        try:
            if self._socket is not None:
                self._socket.close()
            if self._pipe is not None:
                self._pipe.close()
        except OSError:
            pass

    def _read_into(self, view):
        if self._socket is not None:
            return self._socket.recv_into(view)
        return self._pipe.readinto(view) or 0

    def _read_exact(self, size):
        buffer = bytearray(size)
        view = memoryview(buffer)
        filled = 0
        while filled < size:
            try:
                count = self._read_into(view[filled:])
            except OSError as error:
                raise Closed(str(error)) from error
            if count == 0:
                raise Closed("the broker closed the connection")
            filled += count
        return bytes(buffer)

    def _write(self, data):
        try:
            if self._socket is not None:
                self._socket.sendall(data)
            else:
                view = memoryview(data)
                while view:
                    written = self._pipe.write(view)
                    view = view[written:]
        except OSError as error:
            raise Closed(str(error)) from error

    def read_frame(self):
        """Returns (type, payload); raises Closed when the broker is gone."""
        length, frame_type = _HEADER.unpack(self._read_exact(_HEADER.size))
        if length == 0 or length > MAX_FRAME_BODY:
            raise ValueError(f"invalid frame length {length}")
        payload = self._read_exact(length - 1) if length > 1 else b""
        return frame_type, payload

    def send(self, frame_type, *parts):
        """Sends one frame whose payload is the parts joined (bytes-like)."""
        size = sum(len(part) for part in parts)
        if size + 1 > MAX_FRAME_BODY:
            raise ValueError(f"frame of {size} bytes is larger than {MAX_FRAME_BODY}")
        self._write(_HEADER.pack(size + 1, frame_type) + b"".join(bytes(part) for part in parts))

    def send_text(self, frame_type, text):
        self.send(frame_type, text.encode("utf-8"))
