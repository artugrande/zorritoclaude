"""Reflex-layer tests.

The clamp is the one piece of this system that has to be right whether or not
the model, the network or the operator are behaving, so it is tested as a pure
function over sensor states.
"""

from __future__ import annotations

import asyncio

import pytest

from rvr import protocol as p
from rvr.mock import build_mock
from rvr.rover import Rover, SafetyLimits


@pytest.fixture
def rover():
    _world, link, camera = build_mock()
    return Rover(link, camera, SafetyLimits())


def _fresh(rover, telemetry):
    """Install telemetry and mark it as just-arrived."""
    rover._on_telemetry(telemetry)


def test_forward_blocked_by_close_obstacle(rover):
    _fresh(rover, p.Telemetry(distance_cm=10.0, battery_v=7.8))
    assert rover._clamp(60, 60) == (0, 0, "obstacle 10cm ahead")


def test_reverse_allowed_with_obstacle_ahead(rover):
    """Gating reverse would strand the rover nose-first against a wall."""
    _fresh(rover, p.Telemetry(distance_cm=6.0, ir_left=True, ir_right=True, battery_v=7.8))
    assert rover._clamp(-60, -60) == (-60, -60, None)


def test_turning_in_place_allowed_with_obstacle_ahead(rover):
    """A pivot has no net forward component, so it stays available."""
    _fresh(rover, p.Telemetry(distance_cm=6.0, ir_left=True, battery_v=7.8))
    assert rover._clamp(-60, 60) == (-60, 60, None)


def test_forward_scaled_in_the_slow_band(rover):
    _fresh(rover, p.Telemetry(distance_cm=30.0, battery_v=7.8))
    left, right, reason = rover._clamp(90, 90)
    assert 0 < left < 90 and left == right
    assert "slowing" in reason


def test_scaling_below_the_dead_band_becomes_a_stop(rover):
    """Power under ~20 stalls the motors silently; reporting a drive would lie."""
    _fresh(rover, p.Telemetry(distance_cm=19.0, battery_v=7.8))
    left, right, reason = rover._clamp(30, 30)
    assert (left, right) == (0, 0)
    assert "too close" in reason


def test_ir_obstacle_blocks_forward(rover):
    _fresh(rover, p.Telemetry(distance_cm=200.0, ir_left=True, battery_v=7.8))
    assert rover._clamp(60, 60) == (0, 0, "IR obstacle detected on left")


def test_flat_battery_blocks_everything_including_reverse(rover):
    _fresh(rover, p.Telemetry(distance_cm=200.0, battery_v=6.0))
    assert rover._clamp(-60, -60)[:2] == (0, 0)
    assert "battery" in rover._clamp(60, 60)[2]


def test_stale_telemetry_creeps(rover):
    rover._on_telemetry(p.Telemetry(distance_cm=200.0, battery_v=7.8))
    rover._telemetry_at = 0.0  # pretend the last packet was long ago
    left, right, reason = rover._clamp(100, 100)
    assert left <= rover.limits.creep_speed
    assert "stale" in reason


def test_no_echo_is_not_treated_as_open_road(rover):
    """distance_cm None means the sensor saw nothing, which is usually clear --
    but it must not be confused with a large measured distance."""
    _fresh(rover, p.Telemetry(distance_cm=None, battery_v=7.8))
    assert rover._clamp(60, 60) == (60, 60, None)


@pytest.mark.asyncio
async def test_vetoed_drive_reports_honestly(rover):
    await rover.start()
    try:
        await asyncio.sleep(0.2)  # let telemetry arrive from the mock
        rover._on_telemetry(p.Telemetry(distance_cm=5.0, battery_v=7.8))
        result = await rover.drive(70, 70, 300)
        assert result.vetoed is True
        assert result.applied == (0, 0)
        assert "did not move" in result.describe()
    finally:
        await rover.stop()


@pytest.mark.asyncio
async def test_drive_duration_is_capped(rover):
    await rover.start()
    try:
        rover._on_telemetry(p.Telemetry(distance_cm=300.0, battery_v=7.8))
        result = await rover.drive(40, 40, 99999)
        assert result.duration_ms == rover.limits.max_drive_ms
    finally:
        await rover.stop()


@pytest.mark.asyncio
async def test_motion_stops_when_the_target_expires(rover):
    """Nothing holds the motors except a live target, so a wedged caller coasts
    to a stop instead of driving forever."""
    await rover.start()
    try:
        rover._on_telemetry(p.Telemetry(distance_cm=300.0, battery_v=7.8))
        await rover.drive(50, 50, 150, hold=True)
        assert rover.moving is True
        await asyncio.sleep(0.4)
        assert rover.moving is False
    finally:
        await rover.stop()


@pytest.mark.asyncio
async def test_halt_is_immediate_and_synchronous(rover):
    await rover.start()
    try:
        rover._on_telemetry(p.Telemetry(distance_cm=300.0, battery_v=7.8))
        await rover.drive(60, 60, 2000, hold=True)
        rover.halt("test")
        assert rover.moving is False
    finally:
        await rover.stop()
