"""Typed responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Union


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class NoulAnswer:
    """Yes/no answer. ``noul`` is the probability of yes (0 to 1)."""

    noul: float
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    type: str = "noul"

    @property
    def probability(self) -> float:
        return self.noul

    def decide(self, threshold_yes: float = 0.9, threshold_no: float = 0.1) -> str:
        """Return "yes" if p >= threshold_yes, "no" if p <= threshold_no, else "person"
        (hand off to a person)."""
        if not 0.0 <= threshold_no <= threshold_yes <= 1.0:
            raise ValueError("thresholds must satisfy 0 <= threshold_no <= threshold_yes <= 1")
        if self.noul >= threshold_yes:
            return "yes"
        if self.noul <= threshold_no:
            return "no"
        return "person"


@dataclass(frozen=True)
class ChoiceAnswer:
    choice: str
    probabilities: Dict[str, float]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    type: str = "choice"


@dataclass(frozen=True)
class ScoreAnswer:
    score: float
    level: int
    probabilities: Dict[str, float]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    type: str = "score"


Answer = Union[NoulAnswer, ChoiceAnswer, ScoreAnswer]


@dataclass(frozen=True)
class DecisionResponse:
    model: str
    answers: Dict[str, Answer]
    usage: Usage
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class Model:
    id: str
    owned_by: str = ""
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class KeyInfo:
    """The calling key, from ``client.key()``."""

    id: str
    name: Optional[str]
    expires_on: Optional[str]  # the last day the key works (YYYY-MM-DD), or None if it never expires
    days_left: Optional[int]
    workspace: Optional[str]
    rate_limit_per_minute: Optional[int]
    daily_limit: Optional[int]
    paused: bool
    pause_reason: Optional[str] = None  # "credit", "budget" or "model" when paused
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class KeyExpiry:
    """What the client last learnt about its key's expiry, from the response headers."""

    key_id: Optional[str]
    expires_on: str  # the last day the key works (YYYY-MM-DD)
    days_left: int  # whole days from today (UTC); 0 on the last day


def parse_key_info(data: Dict[str, Any]) -> KeyInfo:
    return KeyInfo(
        id=str(data.get("id", "")), name=data.get("name"), expires_on=data.get("expires_on"),
        days_left=data.get("days_left"), workspace=data.get("workspace"),
        rate_limit_per_minute=data.get("rate_limit_per_minute"), daily_limit=data.get("daily_limit"),
        paused=bool(data.get("paused", False)), pause_reason=data.get("pause_reason"), raw=data,
    )


def parse_answer(data: Dict[str, Any]) -> Answer:
    kind = data.get("type")
    if kind == "noul":
        return NoulAnswer(noul=float(data["noul"]), raw=data)
    if kind == "choice":
        return ChoiceAnswer(
            choice=data["choice"],
            probabilities={k: float(v) for k, v in data.get("probabilities", {}).items()},
            raw=data,
        )
    if kind == "score":
        return ScoreAnswer(
            score=float(data["score"]),
            level=int(data["level"]),
            probabilities={k: float(v) for k, v in data.get("probabilities", {}).items()},
            raw=data,
        )
    raise ValueError(f"unknown answer type: {kind!r}")


def parse_response(data: Dict[str, Any]) -> DecisionResponse:
    usage = data.get("usage") or {}
    return DecisionResponse(
        model=data.get("model", ""),
        answers={name: parse_answer(a) for name, a in (data.get("answers") or {}).items()},
        usage=Usage(int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0))),
        raw=data,
    )
