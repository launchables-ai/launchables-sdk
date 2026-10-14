"""Typed responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Union


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
