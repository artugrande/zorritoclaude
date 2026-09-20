"""Wire protocol for the SunFounder Galaxy RVR (firmware v2.0.0).

Verified byte-for-byte against upstream sources:

* ``sunfounder/galaxy-rvr``          ``galaxy-rvr/galaxy-rvr.ino``
  -- ``onReceive()`` (inbound entity ids) and ``handleSensorData()`` (telemetry)
* ``sunfounder/ai-camera-firmware``  ``src/ws_server.cpp``
  -- the WebSocket <-> UART bridge running on the ESP32-CAM
* ``sunfounder/SunFounder_AI_Camera`` ``src/SunFounder_AI_Camera.cpp``
  -- the Arduino-side frame parser that validates what we send

Topology::

    we  --WS binary-->  ESP32-CAM  --UART "WSB+" + bytes-->  Arduino Uno
    we  <--WS binary--  ESP32-CAM  <--UART framed bytes-----  Arduino Uno

For *binary* frames the ESP32 is a pure pass-through -- ``ws_server.cpp`` just
does ``Serial.print("WSB+"); Serial.write(payload, length);`` -- so whatever we
put in a WebSocket binary frame reaches the Arduino's parser verbatim. That
means this module speaks the Arduino's framing directly, and the ESP32 never
has to be reflashed.

Frame layout, both directions::

    +------+-------+----------+----------------+------+
    | 0xA0 |  len  | checksum |  payload[len]  | 0xA1 |
    +------+-------+----------+----------------+------+

``len`` counts the payload only, and is a single byte, so a payload is capped
at 255 bytes.

**Checksum asymmetry -- this is not a typo.** The two firmwares disagree:

* The Arduino *parser* validates ``XOR(payload[0..len))`` -- payload bytes
  only. That is what we must emit, and what :func:`encode_frame` produces.
* The Arduino *emitter* (``handleSensorData``) computes
  ``XOR(0xA0, len, 0x00, payload...)`` -- it folds in the header bytes and the
  still-zeroed checksum placeholder.

So :func:`decode_frame` accepts either convention. Rejecting telemetry over a
checksum the rover itself computes differently would drop every good packet.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

__all__ = [
    "ProtocolError",
    "WS_PORT",
    "CAMERA_PORT",
    "Telemetry",
    "encode_frame",
    "decode_frame",
    "cmd_motors",
    "cmd_rgb",
    "cmd_servo",
    "cmd_lamp",
    "cmd_obstacle_mode",
    "parse_telemetry",
]


class ProtocolError(ValueError):
    """Raised when a frame is malformed beyond what we are willing to tolerate."""


# --- Network endpoints -------------------------------------------------------
# Both come from the firmware, not from the docs: galaxy-rvr.h pins the
# websocket to `#define PORT "30102"` (the neighbouring comment claiming 8765 is
# stale), and camera_server.cpp starts the MJPEG httpd on `config.server_port =
# 9000` with handlers registered at /mjpg and /capture.
WS_PORT = 30102
CAMERA_PORT = 9000
STREAM_PATH = "/mjpg"
CAPTURE_PATH = "/capture"

# The ESP32 drops a client after 3s without traffic (PINGPONG_TIMEOUT), and
# prints [APPSTOP] after 3s without data (DATA_TIMEOUT). Stay well inside both.
PING_INTERVAL = 1.0
PINGPONG_TIMEOUT = 3.0

START_BYTE = 0xA0
END_BYTE = 0xA1
MAX_PAYLOAD = 255

# --- Outbound entity ids (us -> rover), from onReceive() ---------------------
CMD_MOTORS = 0x01          # + int8 left, int8 right   (also forces MODE_APP_CONTROL)
CMD_RGB = 0x02             # + uint8 r, g, b
CMD_SERVO = 0x03           # + uint8 angle, firmware clamps to 0..140
CMD_LAMP = 0x04            # + uint8 0|1, drives the ESP32-CAM flash led
CMD_OBSTACLE_MODE = 0x05   # + uint8 state, uint8 mode, uint8 power

# --- Inbound entity ids (rover -> us), from handleSensorData() ---------------
TLM_ULTRASONIC = 0x81      # + uint16 big-endian, tenths of a mm... see below
TLM_IR = 0x82              # + uint8 bitfield
TLM_BATTERY = 0x83         # + uint8, volts = raw/100 + 6

# Servo geometry. There is exactly one servo (SERVO_PIN 6) and it tilts the
# camera; there is no pan axis, so yaw means turning the whole rover.
SERVO_MIN, SERVO_CENTER, SERVO_MAX = 0, 90, 140

# Motors. carSetMotors() takes int8 and remaps |power| onto PWM 28..255, so
# anything under roughly 20 will not overcome stiction on carpet.
MOTOR_MIN, MOTOR_MAX = -100, 100

# batteryGetPercentage() maps 6.6V..8.4V onto 0..100 (2x 18650 in series).
BATTERY_EMPTY_V, BATTERY_FULL_V = 6.6, 8.4


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


# --- Framing -----------------------------------------------------------------

def encode_frame(payload: bytes) -> bytes:
    """Wrap ``payload`` in the start/len/checksum/end envelope the rover expects.

    The checksum is ``XOR`` over the payload bytes only, matching the validation
    in ``SunFounder_AI_Camera.cpp`` (see the module docstring).
    """
    if len(payload) > MAX_PAYLOAD:
        raise ProtocolError(
            f"payload is {len(payload)} bytes; the length field holds at most {MAX_PAYLOAD}"
        )
    checksum = 0
    for byte in payload:
        checksum ^= byte
    return bytes([START_BYTE, len(payload), checksum]) + payload + bytes([END_BYTE])


def decode_frame(frame: bytes, *, strict: bool = False) -> bytes:
    """Unwrap a frame and return its payload.

    Accepts both checksum conventions described in the module docstring. With
    ``strict=True`` a checksum matching *neither* convention raises; otherwise
    the payload is returned anyway and the caller can decide -- telemetry is
    advisory, and a corrupt distance reading is caught by range checks in
    :func:`parse_telemetry` regardless.
    """
    if len(frame) < 4:
        raise ProtocolError(f"frame too short: {len(frame)} bytes")
    if frame[0] != START_BYTE:
        raise ProtocolError(f"bad start byte 0x{frame[0]:02X}, expected 0x{START_BYTE:02X}")

    length = frame[1]
    expected_total = length + 4
    if len(frame) < expected_total:
        raise ProtocolError(
            f"truncated frame: header declares {length} payload bytes "
            f"({expected_total} total) but got {len(frame)}"
        )
    if frame[expected_total - 1] != END_BYTE:
        raise ProtocolError(
            f"bad end byte 0x{frame[expected_total - 1]:02X}, expected 0x{END_BYTE:02X}"
        )

    declared = frame[2]
    payload = frame[3 : 3 + length]

    payload_only = 0
    for byte in payload:
        payload_only ^= byte
    # What handleSensorData() actually emits: header bytes folded in, with the
    # checksum slot still holding its 0x00 placeholder.
    with_header = payload_only ^ START_BYTE ^ length ^ 0x00

    if strict and declared not in (payload_only, with_header):
        raise ProtocolError(
            f"checksum 0x{declared:02X} matches neither convention "
            f"(payload-only 0x{payload_only:02X}, with-header 0x{with_header:02X})"
        )
    return payload


# --- Outbound commands -------------------------------------------------------

def cmd_motors(left: int, right: int) -> bytes:
    """Set left/right track power, each -100..100.

    Sending this also flips the rover into ``MODE_APP_CONTROL``, cancelling any
    on-board obstacle-avoidance or following mode.
    """
    return struct.pack(
        ">Bbb", CMD_MOTORS, _clamp(left, MOTOR_MIN, MOTOR_MAX), _clamp(right, MOTOR_MIN, MOTOR_MAX)
    )


def cmd_rgb(r: int, g: int, b: int) -> bytes:
    """Set the chassis RGB strip colour."""
    return bytes([CMD_RGB, _clamp(r, 0, 255), _clamp(g, 0, 255), _clamp(b, 0, 255)])


def cmd_servo(angle: int) -> bytes:
    """Tilt the camera. 90 is level; the firmware clamps to 0..140."""
    return bytes([CMD_SERVO, _clamp(angle, SERVO_MIN, SERVO_MAX)])


def cmd_lamp(on: bool) -> bytes:
    """Toggle the ESP32-CAM flash lamp (firmware drives it at level 5/10)."""
    return bytes([CMD_LAMP, 1 if on else 0])


def cmd_obstacle_mode(enabled: bool, following: bool = False, power: int = 65) -> bytes:
    """Hand control to the rover's own obstacle behaviour, or take it back.

    ``enabled=False`` returns the rover to ``MODE_APP_CONTROL``. Note this is the
    *on-board* autonomy (a reflex loop in the Arduino); our own Claude-driven
    autonomy is a different thing entirely and needs this switched off.
    """
    return bytes([CMD_OBSTACLE_MODE, 1 if enabled else 0, 1 if following else 0, _clamp(power, 0, 100)])


# --- Inbound telemetry -------------------------------------------------------

@dataclass(frozen=True)
class Telemetry:
    """A decoded sensor packet. Any field may be ``None`` if absent or unusable."""

    distance_cm: float | None = None
    """Ultrasonic range. ``None`` means no echo -- either out of range (over
    ``MAX_DISTANCE``) or a reading the firmware rejected, which it signals as -1."""

    ir_left: bool | None = None
    """True when the left IR sensor sees an obstacle."""

    ir_right: bool | None = None
    """True when the right IR sensor sees an obstacle."""

    battery_v: float | None = None

    @property
    def battery_pct(self) -> float | None:
        if self.battery_v is None:
            return None
        span = BATTERY_FULL_V - BATTERY_EMPTY_V
        return max(0.0, min(100.0, (self.battery_v - BATTERY_EMPTY_V) / span * 100.0))

    @property
    def blocked_ahead(self) -> bool:
        """Any sensor currently reporting something in the way."""
        return bool(self.ir_left) or bool(self.ir_right) or (
            self.distance_cm is not None and self.distance_cm < 15.0
        )

    def merged_with(self, older: "Telemetry") -> "Telemetry":
        """Fill this packet's missing fields from an older one."""
        return Telemetry(
            distance_cm=self.distance_cm if self.distance_cm is not None else older.distance_cm,
            ir_left=self.ir_left if self.ir_left is not None else older.ir_left,
            ir_right=self.ir_right if self.ir_right is not None else older.ir_right,
            battery_v=self.battery_v if self.battery_v is not None else older.battery_v,
        )

    def describe(self) -> str:
        """One line of plain text, for the agent's tool results and the UI."""
        if self.distance_cm is None:
            dist = "clear (no echo within range)"
        else:
            dist = f"{self.distance_cm:.0f} cm ahead"
        blocked = [
            side
            for side, hit in (("left", self.ir_left), ("right", self.ir_right))
            if hit
        ]
        ir = f"IR obstacle on the {' and '.join(blocked)}" if blocked else "IR clear"
        if self.battery_v is None:
            batt = "battery unknown"
        else:
            batt = f"battery {self.battery_v:.2f}V ({self.battery_pct:.0f}%)"
        return f"{dist}; {ir}; {batt}"


def parse_telemetry(payload: bytes) -> Telemetry:
    """Decode a telemetry payload emitted by ``handleSensorData()``.

    Walks the entity-tagged stream and ignores tags it does not know, so a
    firmware that grows a new sensor will not break this.
    """
    distance_cm: float | None = None
    ir_left: bool | None = None
    ir_right: bool | None = None
    battery_v: float | None = None

    i = 0
    while i < len(payload):
        tag = payload[i]
        if tag == TLM_ULTRASONIC and i + 2 < len(payload):
            raw = (payload[i + 1] << 8) | payload[i + 2]
            # ultrasonicRead() returns -1.0 when the echo times out or exceeds
            # MAX_DISTANCE; the firmware multiplies by 10 and stuffs it into a
            # uint16, so -1 arrives as 0xFFF6. Anything with the sign bit set is
            # one of those sentinels, not a distance.
            distance_cm = None if raw >= 0x8000 else raw / 10.0
            i += 3
        elif tag == TLM_IR and i + 1 < len(payload):
            bits = payload[i + 1]
            ir_left = bool(bits & 0b10)   # irObstacleRead(): (left << 1) | right
            ir_right = bool(bits & 0b01)
            i += 2
        elif tag == TLM_BATTERY and i + 1 < len(payload):
            battery_v = payload[i + 1] / 100.0 + 6.0
            i += 2
        else:
            i += 1  # unknown tag, or a truncated tail: skip a byte and resync

    return Telemetry(
        distance_cm=distance_cm, ir_left=ir_left, ir_right=ir_right, battery_v=battery_v
    )
