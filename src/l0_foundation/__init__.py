"""L0 foundation layer — device registry and fire-and-forget broadcast.

Answers one question: which devices exist, and how do we reach them?
There is no optimization, no live status, and no ack path here. Those
are L1/L2. `DEVICE.reserve_bound_pct` is stored and never read by L0.
"""

from l0_foundation.channels import ChannelSender, FireAndForgetBus
from l0_foundation.comparators import compare
from l0_foundation.engine import evaluate_signals
from l0_foundation.entities import (
    DEVICE_STATUSES,
    BroadcastList,
    Channel,
    Device,
    DispatchLog,
    IncomingSignal,
    ListMembership,
    Site,
    ThresholdRule,
)

__all__ = [
    "DEVICE_STATUSES",
    "BroadcastList",
    "Channel",
    "ChannelSender",
    "Device",
    "DispatchLog",
    "FireAndForgetBus",
    "IncomingSignal",
    "ListMembership",
    "Site",
    "ThresholdRule",
    "compare",
    "evaluate_signals",
]
