"""Channel.send — fire-and-forget.

L0 callers must not inspect a return value. At L1 this same call site
gains a return path (ack / nack / timeout). L1 does not replace the
interface; it adds a return path to it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Protocol

from l0_foundation.entities import Channel
from l0_foundation.ids import new_id


@dataclass(frozen=True)
class SendAttempt:
    """Transport journal only. Not an ack, not a per-device outcome."""

    send_id: str
    channel_id: str
    channel_type: str
    endpoint: str
    instruction_text: str
    attempted_at: datetime


class ChannelSender(Protocol):
    def send(
        self,
        channel: Channel,
        instruction: str,
        on_ack: Callable[[bool], None] | None = None,
    ) -> None: ...


class FireAndForgetBus:
    """Dispatches by channel_type. Adapters are swappable; schema is not."""

    def __init__(self) -> None:
        self.attempts: list[SendAttempt] = []
        self._adapters: dict[str, ChannelAdapter] = {
            "sms": LogAdapter("SMS"),
            "phone": LogAdapter("VOICE"),
            "relay": LogAdapter("RELAY"),
            "api": LogAdapter("API"),
        }

    def register(self, channel_type: str, adapter: ChannelAdapter) -> None:
        self._adapters[channel_type] = adapter

    def send(
        self,
        channel: Channel,
        instruction: str,
        on_ack: Callable[[bool], None] | None = None,
    ) -> None:
        adapter = self._adapters.get(channel.channel_type, LogAdapter(channel.channel_type.upper()))
        adapter.deliver(channel.endpoint, instruction)
        self.attempts.append(
            SendAttempt(
                send_id=new_id("send"),
                channel_id=channel.channel_id,
                channel_type=channel.channel_type,
                endpoint=channel.endpoint,
                instruction_text=instruction,
                attempted_at=datetime.now(timezone.utc),
            )
        )
        if on_ack is not None:
            on_ack(True)


class ChannelAdapter(Protocol):
    def deliver(self, endpoint: str, instruction: str) -> None: ...


class LogAdapter:
    def __init__(self, label: str) -> None:
        self.label = label
        self.delivered: list[tuple[str, str]] = []

    def deliver(self, endpoint: str, instruction: str) -> None:
        self.delivered.append((endpoint, instruction))
        print(f"[L0 {self.label}] {endpoint} <- {instruction}", flush=True)
