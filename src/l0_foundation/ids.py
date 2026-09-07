from __future__ import annotations

import uuid

PREFIXES = {
    "site": "sit",
    "channel": "ch",
    "device": "dev",
    "list": "lst",
    "rule": "rul",
    "event": "evt",
    "send": "snd",
    "signal": "sig",
    "message": "msg",
    "tel": "tel",
    "run": "run",
    "alloc": "alloc",
    "rsv": "rsv",
}


def new_id(kind: str) -> str:
    prefix = PREFIXES[kind]
    return f"{prefix}_{uuid.uuid4().hex[:12]}"
