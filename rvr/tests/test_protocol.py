"""Protocol tests written against the firmware's own byte layout.

`_firmware_sensor_frame` is a line-by-line transcription of `handleSensorData()`
from galaxy-rvr.ino, including its header-folding checksum. If upstream changes
the wire format, these tests are where it should surface.
"""

from __future__ import annotations

import pytest

from rvr import protocol as p


# --- Framing -----------------------------------------------------------------

def test_encode_uses_payload_only_checksum():
    """This is the convention SunFounder_AI_Camera.cpp validates against."""
    frame = p.encode_frame(bytes([0x01, 0x32, 0x32]))
    assert frame[0] == p.START_BYTE
    assert frame[1] == 3
    assert frame[2] == 0x01 ^ 0x32 ^ 0x32
    assert frame[-1] == p.END_BYTE


def test_roundtrip():
    for payload in (b"", b"\x01", bytes(range(64)), bytes(255)):
        assert p.decode_frame(p.encode_frame(payload), strict=True) == payload


def test_payload_longer_than_length_field_is_rejected():
    with pytest.raises(p.ProtocolError, match="at most 255"):
        p.encode_frame(bytes(256))


@pytest.mark.parametrize(
    "frame, match",
    [
        (b"\x00\x00", "too short"),
        (b"\x00\x00\x00\xa1", "bad start byte"),
        (b"\xa0\x08\x00\x01\xa1", "truncated"),
        (b"\xa0\x01\x01\x01\x00", "bad end byte"),
    ],
)
def test_malformed_frames_raise(frame, match):
    with pytest.raises(p.ProtocolError, match=match):
        p.decode_frame(frame)


def test_bad_checksum_tolerated_unless_strict():
    frame = bytearray(p.encode_frame(b"\x81\x01\x2c"))
    frame[2] ^= 0xFF
    assert p.decode_frame(bytes(frame)) == b"\x81\x01\x2c"
    with pytest.raises(p.ProtocolError, match="neither convention"):
        p.decode_frame(bytes(frame), strict=True)


# --- Outbound commands -------------------------------------------------------

def test_motor_power_is_signed():
    assert p.cmd_motors(-100, 100) == bytes([0x01, 0x9C, 0x64])  # -100 -> 0x9C two's complement
    assert p.cmd_motors(0, 0) == bytes([0x01, 0x00, 0x00])


def test_motor_power_clamps_to_int8_range():
    """Out-of-range values must clamp, never wrap -- a wrapped 200 becomes -56
    and the rover drives backwards."""
    assert p.cmd_motors(200, -200) == bytes([0x01, 0x64, 0x9C])


def test_servo_clamps_to_firmware_range():
    assert p.cmd_servo(90) == bytes([0x03, 90])
    assert p.cmd_servo(255) == bytes([0x03, 140])
    assert p.cmd_servo(-40) == bytes([0x03, 0])


def test_obstacle_mode_flags():
    assert p.cmd_obstacle_mode(False) == bytes([0x05, 0, 0, 65])
    assert p.cmd_obstacle_mode(True, following=True, power=80) == bytes([0x05, 1, 1, 80])


def test_lamp_and_rgb():
    assert p.cmd_lamp(True) == bytes([0x04, 1])
    assert p.cmd_rgb(300, -5, 128) == bytes([0x02, 255, 0, 128])


# --- Telemetry, against a faithful copy of the firmware emitter --------------

def _firmware_sensor_frame(distance_cm: float, ir_bits: int, battery_v: float) -> bytes:
    """Transcription of handleSensorData() in galaxy-rvr.ino, warts included."""
    ultrasonic_mm = int(distance_cm * 10.0) & 0xFFFF  # uint16_t truncation
    battery_raw = round((battery_v - 6) * 100)

    out = bytearray()
    out.append(p.START_BYTE)
    out.append(0x00)  # length placeholder
    out.append(0x00)  # checksum placeholder
    out += bytes([0x81, ultrasonic_mm >> 8, ultrasonic_mm & 0xFF])
    out += bytes([0x82, ir_bits])
    out += bytes([0x83, battery_raw])
    out.append(p.END_BYTE)

    out[1] = len(out) - 4
    checksum = 0
    for byte in out[: len(out) - 1]:  # folds in header + zeroed checksum slot
        checksum ^= byte
    out[2] = checksum
    return bytes(out)


def test_decodes_a_real_firmware_frame():
    frame = _firmware_sensor_frame(42.3, 0b10, 7.85)
    telemetry = p.parse_telemetry(p.decode_frame(frame, strict=True))

    assert telemetry.distance_cm == pytest.approx(42.3, abs=0.1)
    assert telemetry.ir_left is True
    assert telemetry.ir_right is False
    assert telemetry.battery_v == pytest.approx(7.85, abs=0.01)
    assert telemetry.battery_pct == pytest.approx(69.4, abs=1.0)


def test_out_of_range_ultrasonic_is_none_not_a_huge_distance():
    """ultrasonicRead() returns -1, which the firmware casts to uint16 as 0xFFF6.
    Read naively that is 6553.5 cm of clear road."""
    telemetry = p.parse_telemetry(p.decode_frame(_firmware_sensor_frame(-1, 0, 7.4)))
    assert telemetry.distance_cm is None
    assert telemetry.blocked_ahead is False


def test_ir_bitfield_order_matches_irObstacleRead():
    """(left << 1) | right -- getting this backwards steers into obstacles."""
    both = p.parse_telemetry(p.decode_frame(_firmware_sensor_frame(50, 0b11, 7.4)))
    assert both.ir_left and both.ir_right
    right_only = p.parse_telemetry(p.decode_frame(_firmware_sensor_frame(50, 0b01, 7.4)))
    assert right_only.ir_right and not right_only.ir_left


def test_blocked_ahead_triggers_on_close_range():
    assert p.parse_telemetry(p.decode_frame(_firmware_sensor_frame(8, 0, 7.4))).blocked_ahead
    assert not p.parse_telemetry(p.decode_frame(_firmware_sensor_frame(80, 0, 7.4))).blocked_ahead


def test_unknown_tags_do_not_derail_parsing():
    payload = bytes([0xEE, 0x99]) + bytes([0x83, 140])
    assert p.parse_telemetry(payload).battery_v == pytest.approx(7.4, abs=0.01)


def test_truncated_payload_yields_partial_telemetry():
    telemetry = p.parse_telemetry(bytes([0x81, 0x01]))  # ultrasonic tag, missing LSB
    assert telemetry.distance_cm is None
    assert telemetry.battery_v is None


def test_merged_with_fills_gaps():
    fresh = p.Telemetry(distance_cm=30.0)
    older = p.Telemetry(distance_cm=99.0, battery_v=7.4, ir_left=False)
    merged = fresh.merged_with(older)
    assert merged.distance_cm == 30.0 and merged.battery_v == 7.4


def test_describe_is_human_readable():
    text = p.Telemetry(distance_cm=25.0, ir_left=True, ir_right=False, battery_v=7.4).describe()
    assert "25 cm ahead" in text and "left" in text and "7.40V" in text
