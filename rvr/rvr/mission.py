"""Mission goals, findings, and the report you get at the end.

The findings log is the actual product of an autonomous run. A rover that
explored beautifully and told you nothing did nothing.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

IMPORTANCE = ("routine", "notable", "important")


@dataclass
class Finding:
    id: str
    text: str
    importance: str = "notable"
    image: str | None = None
    place: str | None = None
    at: float = field(default_factory=time.time)


@dataclass
class Mission:
    id: str
    goal: str
    status: str = "running"  # running | complete | aborted
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    summary: str = ""
    findings: list[Finding] = field(default_factory=list)
    steps: int = 0

    @property
    def duration_s(self) -> float:
        return (self.ended_at or time.time()) - self.started_at

    def as_dict(self) -> dict:
        data = asdict(self)
        data["duration_s"] = round(self.duration_s, 1)
        return data


class MissionLog:
    """Holds the active mission and the archive of finished ones."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.images = self.root / "findings"
        self.path = self.root / "missions.json"
        self.root.mkdir(parents=True, exist_ok=True)
        self.images.mkdir(parents=True, exist_ok=True)
        self.missions: list[Mission] = []
        self.current: Mission | None = None
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return
        for entry in raw.get("missions", []):
            entry["findings"] = [Finding(**f) for f in entry.get("findings", [])]
            self.missions.append(Mission(**entry))

    def save(self) -> None:
        payload = {"missions": [mission.as_dict() for mission in self.missions[-50:]]}
        for mission in payload["missions"]:
            mission.pop("duration_s", None)
        temp = self.path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
        temp.replace(self.path)

    def start(self, goal: str) -> Mission:
        mission = Mission(id=uuid.uuid4().hex[:8], goal=goal)
        self.missions.append(mission)
        self.current = mission
        self.save()
        return mission

    def add_finding(
        self,
        text: str,
        *,
        importance: str = "notable",
        jpeg: bytes | None = None,
        place: str | None = None,
    ) -> Finding:
        if importance not in IMPORTANCE:
            importance = "notable"
        finding = Finding(id=uuid.uuid4().hex[:8], text=text, importance=importance, place=place)
        if jpeg:
            path = self.images / f"{finding.id}.jpg"
            path.write_bytes(jpeg)
            finding.image = str(path.relative_to(self.root))
        if self.current is not None:
            self.current.findings.append(finding)
        self.save()
        return finding

    def finish(self, summary: str, status: str = "complete") -> Mission | None:
        mission = self.current
        if mission is None:
            return None
        mission.status = status
        mission.summary = summary
        mission.ended_at = time.time()
        self.current = None
        self.save()
        return mission

    def report(self, mission: Mission) -> str:
        """A readable write-up of one run."""
        lines = [
            f"# Mission: {mission.goal}",
            "",
            f"Status: {mission.status} | Duration: {mission.duration_s / 60:.1f} min "
            f"| Steps: {mission.steps} | Findings: {len(mission.findings)}",
            "",
        ]
        if mission.summary:
            lines += ["## Summary", "", mission.summary, ""]
        if mission.findings:
            lines += ["## Findings", ""]
            for finding in mission.findings:
                when = time.strftime("%H:%M:%S", time.localtime(finding.at))
                where = f" @ {finding.place}" if finding.place else ""
                lines.append(f"- **[{finding.importance}]** {when}{where} — {finding.text}")
                if finding.image:
                    lines.append(f"  - ![]({finding.image})")
        return "\n".join(lines)
