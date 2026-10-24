"""Helpers that build and validate question objects."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Union

from .errors import ValidationError

MAX_QUESTIONS = 256  # the API's largest limits (Myles-G 12B since 24 Oct 2026); a model on lower limits answers 422
MAX_OPTIONS = 256
MAX_OPTIONS_TOTAL = 4096  # options over all questions in one request
QUESTION_TYPES = ("noul", "choice", "score")

Question = Dict[str, Any]


def _instructions(instructions: Any) -> str:
    if not isinstance(instructions, str) or not instructions.strip():
        raise ValidationError("instructions must be a non-empty string")
    return instructions


def noul(instructions: str, true: Optional[str] = None, false: Optional[str] = None) -> Question:
    """A yes/no question. The answer is the probability of yes.

    ``true`` and ``false`` optionally describe what each answer means.
    """
    q: Question = {"type": "noul", "instructions": _instructions(instructions)}
    if true is not None or false is not None:
        criteria: Dict[str, str] = {}
        if true is not None:
            criteria["true"] = true
        if false is not None:
            criteria["false"] = false
        q["criteria"] = criteria
    return q


def choice(instructions: str, options: Union[Mapping[str, str], Iterable[str]]) -> Question:
    """Pick one label. ``options`` is a list of labels or a {label: description} dict."""
    if isinstance(options, str):
        raise ValidationError("options must be a list of labels or a {label: description} dict")
    if isinstance(options, Mapping):
        criteria: Any = dict(options)
        labels = list(criteria)
    else:
        criteria = list(options)
        labels = criteria
    if not labels:
        raise ValidationError("choice needs at least one option")
    if len(labels) > MAX_OPTIONS:
        raise ValidationError(f"choice supports at most {MAX_OPTIONS} options, got {len(labels)}")
    if not all(isinstance(label, str) and label for label in labels):
        raise ValidationError("choice labels must be non-empty strings")
    if len(set(labels)) != len(labels):
        raise ValidationError("choice labels must be unique")
    return {"type": "choice", "instructions": _instructions(instructions), "criteria": criteria}


def score(instructions: str, levels: Iterable[str]) -> Question:
    """Rate on a scale. ``levels`` describes each level, lowest first (numbered from 0)."""
    if isinstance(levels, (str, Mapping)):
        raise ValidationError("levels must be a list of descriptions, lowest first")
    criteria: List[str] = list(levels)
    if len(criteria) < 2:
        raise ValidationError("score needs at least two levels")
    if not all(isinstance(level, str) and level for level in criteria):
        raise ValidationError("score levels must be non-empty strings")
    return {"type": "score", "instructions": _instructions(instructions), "criteria": criteria}


def validate_questions(questions: Any) -> Dict[str, Question]:
    """Check a {name: question} mapping before it is sent."""
    if not isinstance(questions, Mapping) or not questions:
        raise ValidationError("questions must be a non-empty dict of {name: question}")
    if len(questions) > MAX_QUESTIONS:
        raise ValidationError(f"at most {MAX_QUESTIONS} questions per request, got {len(questions)}")
    out: Dict[str, Question] = {}
    total = 0
    for name, q in questions.items():
        if not isinstance(name, str) or not name:
            raise ValidationError("question names must be non-empty strings")
        if not isinstance(q, Mapping):
            raise ValidationError(f"question {name!r} must be a dict (build it with noul/choice/score)")
        qtype = q.get("type")
        if qtype not in QUESTION_TYPES:
            raise ValidationError(f"question {name!r}: type must be one of {', '.join(QUESTION_TYPES)}, got {qtype!r}")
        _instructions_checked(name, q)
        crit = q.get("criteria")
        if qtype == "choice":
            if not isinstance(crit, (Mapping, list, tuple)) or not crit:
                raise ValidationError(f"question {name!r}: choice needs criteria (options)")
            if len(crit) > MAX_OPTIONS:
                raise ValidationError(f"question {name!r}: at most {MAX_OPTIONS} options, got {len(crit)}")
        elif qtype == "score":
            if not isinstance(crit, (list, tuple)) or not crit:
                raise ValidationError(f"question {name!r}: score needs criteria (a list of level descriptions)")
        total += len(crit) if isinstance(crit, (Mapping, list, tuple)) and qtype != "noul" else 2  # as the server counts
        if total > MAX_OPTIONS_TOTAL:
            raise ValidationError(f"at most {MAX_OPTIONS_TOTAL} options over all questions in one request")
        out[name] = dict(q)
    return out


def _instructions_checked(name: str, q: Mapping) -> None:
    ins = q.get("instructions")
    if not isinstance(ins, str) or not ins.strip():
        raise ValidationError(f"question {name!r}: instructions must be a non-empty string")
