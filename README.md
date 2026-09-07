# L2 — Capability & Allocation Layer

Forked from [l1-control-channel](https://github.com/hv4626/l1-control-channel). Spec: `docs/L2_capability_allocation_model.md`.

L0 asked *which devices exist, and how do we reach them?* L1 asked *did the instruction land*, and *is the failsafe configured?* L2 asks *how much can each device actually give right now*, and *how should a fleet-level target be split without breaching a customer guarantee or a site export limit*.

Live console: **https://hv4626.github.io/l2-capability-allocation/**

## What L2 adds

- `DEVICE_CAPABILITY` physics model (separate from L0's registry)
- `TELEMETRY_SAMPLE` ingest; stale devices are excluded
- `THRESHOLD_RULE.instruction_type = fleet_target` with `target_kw` + `duration_min`
- Equal-stress QP (outer λ, inner site μ) — no solver library
- `HEADROOM_RESERVATION` taken before send so overlapping events cannot double-count kWh
- `SOLVER_RUN` + `DEVICE_ALLOCATION` (quantized setpoint, binding constraint)
- `setpoint_revision` and `release` on L1's channel (in-flight guard, not `dispatched` skip)
- L1 v3 patch in this tree: skip only while a `CHANNEL_MESSAGE` is `pending`

Deliberately not L2: forecasts, multi-period, baseline M&V, market price (L3/L4).

## Run locally

```bash
cd web
npm install
npm run dev
```

Python:

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest -q
```
