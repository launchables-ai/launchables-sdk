"""The key management API: list, create, roll and revoke your organisation's API keys with an admin key."""

from __future__ import annotations

import urllib.parse
from typing import TYPE_CHECKING, Any, Dict, Iterator, Optional

from .errors import ValidationError

if TYPE_CHECKING:
    from .client import Launchables

KEYS_PATH = "/api/v1/admin/keys"


def _key_path(key_id: str) -> str:
    if not isinstance(key_id, str) or not key_id:
        raise ValidationError('key_id must be a key id, e.g. "c_1a2b3c4d"')
    return f"{KEYS_PATH}/{urllib.parse.quote(key_id, safe='')}"


class AdminKeys:
    """The organisation's API keys, through the key management API. Needs an admin key.

    Responses are the API's JSON as dictionaries. A key in a list never includes the secret; ``create`` and ``roll``
    return the new key's full secret under ``"key"``, once.
    """

    def __init__(self, client: "Launchables") -> None:
        self._client = client

    def list(self, limit: Optional[int] = None, before: Optional[str] = None) -> Dict[str, Any]:
        """One page of the organisation's keys, newest first: ``{"data": [...], "has_more": bool, "next_before": str | None}``.
        When ``has_more`` is true, pass ``next_before`` as ``before`` to get the next page. ``limit`` is 1 to 500 (default 100)."""
        params = {}
        if limit is not None:
            params["limit"] = str(limit)
        if before is not None:
            params["before"] = before
        query = urllib.parse.urlencode(params)
        return self._client._admin_request("GET", KEYS_PATH + (f"?{query}" if query else ""))

    def list_all(self, limit: Optional[int] = None) -> Iterator[Dict[str, Any]]:
        """Every key, newest first, fetching pages as needed."""
        before: Optional[str] = None
        while True:
            page = self.list(limit=limit, before=before)
            for key in page.get("data", []):
                yield key
            if not page.get("has_more") or not page.get("next_before"):
                return
            before = page["next_before"]

    def create(self, name: str, workspace_id: Optional[str] = None, expires_in_days: Optional[int] = None) -> Dict[str, Any]:
        """Make a new key. ``workspace_id`` defaults to the organisation's default workspace; ``expires_in_days`` is 30,
        90, 180 or 365 (default 90, never longer than the organisation allows). The response holds the full key, once."""
        if not isinstance(name, str) or not name.strip():
            raise ValidationError("name is required")
        body: Dict[str, Any] = {"name": name}
        if workspace_id is not None:
            body["workspace_id"] = workspace_id
        if expires_in_days is not None:
            body["expires_in_days"] = expires_in_days
        return self._client._admin_request("POST", KEYS_PATH, body)

    def roll(self, key_id: str) -> Dict[str, Any]:
        """Replace a key with a new one (same name, workspace and limits). The old key keeps working until the end of
        tomorrow; the response says when, under ``"replaces"``."""
        return self._client._admin_request("POST", _key_path(key_id) + "/roll")

    def revoke(self, key_id: str) -> Dict[str, Any]:
        """Revoke a key. It stops working within a minute. Revoking a revoked key is not an error."""
        return self._client._admin_request("DELETE", _key_path(key_id))


class Admin:
    """``client.admin``: the key management API."""

    def __init__(self, client: "Launchables") -> None:
        self.keys = AdminKeys(client)
