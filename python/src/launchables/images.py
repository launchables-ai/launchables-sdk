"""Image inputs for ``decide``: the ``Image`` helper and the checks run on ``assets`` and ``image_budget``."""

from __future__ import annotations

import base64
import os
from typing import Any, Dict, Mapping, Optional, Union

from .errors import ValidationError

#: The formats the API reads. "jpg" and "jpeg" are the same format.
IMAGE_FORMATS = ("png", "jpg", "jpeg")
#: The ``image_budget`` values the API accepts: the most visual tokens one image may use.
IMAGE_BUDGETS = (70, 140, 280)
#: The largest image the API accepts, in bytes (16 MiB).
MAX_IMAGE_BYTES = 16 * 1024 * 1024

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"


def detect_format(data: bytes) -> Optional[str]:
    """``"png"`` or ``"jpeg"`` from the file's first bytes, or None for anything else."""
    if data.startswith(_PNG_MAGIC):
        return "png"
    if data.startswith(_JPEG_MAGIC):
        return "jpeg"
    return None


def _same_format(a: str, b: str) -> bool:
    jpeg = ("jpg", "jpeg")
    return a == b or (a in jpeg and b in jpeg)


class Image:
    """An image to pass in ``decide(..., assets={reference: Image})``.

    >>> Image.from_path("receipt.jpg")
    >>> Image.from_bytes(png_bytes)            # format detected from the bytes
    >>> Image.from_bytes(data, format="jpeg")

    The bytes are sent as they are: the client never resizes or re-encodes an image.
    """

    __slots__ = ("format", "data")

    def __init__(self, data: bytes, format: Optional[str] = None) -> None:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise ValidationError("image data must be bytes")
        data = bytes(data)
        if len(data) > MAX_IMAGE_BYTES:
            raise ValidationError(f"image is {len(data)} bytes; the most the API accepts is {MAX_IMAGE_BYTES} (16 MiB)")
        detected = detect_format(data)
        if format is None:
            if detected is None:
                raise ValidationError("image is not a PNG or JPEG file (the only formats the API reads)")
            format = detected
        else:
            if not isinstance(format, str) or format.lower() not in IMAGE_FORMATS:
                raise ValidationError(f"image format must be one of {', '.join(IMAGE_FORMATS)}, got {format!r}")
            format = format.lower()
            if detected is None or not _same_format(format, detected):
                raise ValidationError(
                    f"image bytes are not {format.upper()}"
                    + (f" (they look like {detected.upper()})" if detected else " (not a PNG or JPEG file)")
                )
        #: "png", "jpg" or "jpeg".
        self.format: str = format
        #: The file's bytes, unchanged.
        self.data: bytes = data

    @classmethod
    def from_bytes(cls, data: bytes, format: Optional[str] = None) -> "Image":
        """An image from its file bytes. Without ``format``, it is detected from the bytes (PNG or JPEG)."""
        return cls(data, format)

    @classmethod
    def from_path(cls, path: Union[str, "os.PathLike[str]"], format: Optional[str] = None) -> "Image":
        """An image read from a file. Without ``format``, it is detected from the bytes (PNG or JPEG), not the file name."""
        size = os.path.getsize(path)
        if size > MAX_IMAGE_BYTES:
            raise ValidationError(f"{os.fspath(path)} is {size} bytes; the most the API accepts is {MAX_IMAGE_BYTES} (16 MiB)")
        with open(path, "rb") as f:
            return cls(f.read(), format)

    def to_dict(self) -> Dict[str, str]:
        """The asset as sent: ``{"type": "image", "format": ..., "data_base64": ...}``."""
        return {"type": "image", "format": self.format, "data_base64": base64.b64encode(self.data).decode("ascii")}

    def __repr__(self) -> str:
        return f"Image(format={self.format!r}, {len(self.data)} bytes)"


def validate_assets(assets: Any) -> Dict[str, Any]:
    """Check a {reference: image} mapping and build the ``assets`` object. Plain dicts are sent as they are."""
    if not isinstance(assets, Mapping):
        raise ValidationError("assets must be a dict of {reference: Image}")
    out: Dict[str, Any] = {}
    for ref, value in assets.items():
        if not isinstance(ref, str) or not ref:
            raise ValidationError("asset references must be non-empty strings")
        if isinstance(value, Image):
            out[ref] = value.to_dict()
        elif isinstance(value, Mapping):
            out[ref] = dict(value)
        else:
            raise ValidationError(
                f"asset {ref!r} must be an Image (Image.from_path or Image.from_bytes) or a dict "
                '{"type": "image", "format": ..., "data_base64": ...}'
            )
    return out


def validate_image_budget(image_budget: Any) -> int:
    if isinstance(image_budget, bool) or not isinstance(image_budget, int) or image_budget not in IMAGE_BUDGETS:
        raise ValidationError(f"image_budget must be one of {', '.join(map(str, IMAGE_BUDGETS))}, got {image_budget!r}")
    return image_budget
