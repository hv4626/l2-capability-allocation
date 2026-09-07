from __future__ import annotations

import argparse
import json

from l0_foundation.channels import FireAndForgetBus
from l0_foundation.engine import evaluate_signals
from l0_foundation.entities import IncomingSignal
from l0_foundation.seed import seed
from l0_foundation.store import Store


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="l0", description="L0 foundation layer")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("seed", help="load the demo fleet")
    sub.add_parser("devices", help="print reachability table")
    ev = sub.add_parser("evaluate", help="inject a signal and run the loop")
    ev.add_argument("--source", required=True)
    ev.add_argument("--value", required=True, type=float)
    ev.add_argument("--signal-id", dest="signal_id", default="")
    serve = sub.add_parser("serve", help="run the operator API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8000, type=int)

    args = parser.parse_args(argv)
    store = Store()

    if args.cmd == "seed":
        seed(store)
        print(f"seeded {len(store.list_devices())} devices")
        return

    if args.cmd == "devices":
        channels = {c.channel_id: c for c in store.list_channels()}
        sites = {s.site_id: s for s in store.list_sites()}
        print(
            f"{'device':<16} {'class':<12} {'status':<14} {'site':<16} "
            f"{'territory':<10} {'channel':<8} endpoint"
        )
        for d in store.list_devices():
            ch = channels[d.channel_id]
            site = sites[d.site_id]
            print(
                f"{d.device_id:<16} {d.device_class:<12} {d.device_status:<14} "
                f"{d.site_id:<16} {site.utility_territory:<10} {ch.channel_type:<8} {ch.endpoint}"
            )
        return

    if args.cmd == "evaluate":
        bus = FireAndForgetBus()
        events = evaluate_signals(
            [IncomingSignal(args.source, args.value, args.signal_id)],
            store,
            bus,
        )
        print(json.dumps({
            "fired": [
                {
                    "event_id": e.event_id,
                    "rule_id": e.rule_id,
                    "triggered_at": e.triggered_at.isoformat(),
                    "instruction_text": e.instruction_text,
                    "signal_id": e.signal_id,
                }
                for e in events
            ],
            "sends": [
                {
                    "channel_id": s.channel_id,
                    "channel_type": s.channel_type,
                    "endpoint": s.endpoint,
                    "instruction_text": s.instruction_text,
                }
                for s in bus.attempts
            ],
        }, indent=2, default=str))
        return

    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("l0_foundation.api:app", host=args.host, port=args.port, reload=False)
