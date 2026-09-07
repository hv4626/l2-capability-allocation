"""L2 equal-stress QP: outer bisection on λ, inner bisection on μ_k.

No solver library. Charge case is solved on |R| then signs are restored.
"""

from __future__ import annotations

from dataclasses import dataclass

M_PENALTY = 1e6
EPS = 1e-9
BISECT = 72


@dataclass
class DeviceQP:
    device_id: str
    site_id: str
    pbar: float
    c: float
    step: float
    binary: bool


@dataclass
class SolveResult:
    p: dict[str, float]
    p_raw: dict[str, float]
    shortfall: float
    lam: float
    mu: dict[str, float]
    quantization_loss: float
    sites_binding: int


def clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def p_from_dual(lam: float, mu: float, pbar: float, c: float) -> float:
    if pbar <= EPS or c == float("inf"):
        return 0.0
    return clip((lam - mu) / c, 0.0, pbar)


def _site_sum(lam: float, mu: float, devices: list[DeviceQP]) -> float:
    return sum(p_from_dual(lam, mu, d.pbar, d.c) for d in devices)


def _inner_mu(lam: float, devices: list[DeviceQP], g: float) -> float:
    if g == float("inf") or _site_sum(lam, 0.0, devices) <= g + EPS:
        return 0.0
    lo, hi = 0.0, max(lam, 0.0)
    for _ in range(BISECT):
        mid = (lo + hi) / 2
        if _site_sum(lam, mid, devices) > g:
            lo = mid
        else:
            hi = mid
    return hi


def _groups(devices: list[DeviceQP]) -> dict[str, list[DeviceQP]]:
    out: dict[str, list[DeviceQP]] = {}
    for d in devices:
        out.setdefault(d.site_id, []).append(d)
    return out


def _total(lam: float, groups: dict[str, list[DeviceQP]], g_k: dict[str, float]) -> tuple[float, dict[str, float]]:
    mu: dict[str, float] = {}
    tot = 0.0
    for site_id, members in groups.items():
        mu_k = _inner_mu(lam, members, g_k.get(site_id, float("inf")))
        mu[site_id] = mu_k
        tot += _site_sum(lam, mu_k, members)
    return tot, mu


def solve_qp(
    target: float,
    devices: list[DeviceQP],
    g_k: dict[str, float],
) -> SolveResult:
    """Solve for a non-negative target. Caller flips sign for charge."""
    r = abs(target)
    active = [d for d in devices if d.pbar > EPS]
    if not active or r <= EPS:
        return SolveResult({}, {}, r, 0.0, {}, 0.0, 0)

    groups = _groups(active)
    lo, hi = 0.0, M_PENALTY
    for _ in range(BISECT):
        mid = (lo + hi) / 2
        tot, _mu = _total(mid, groups, g_k)
        if tot < r:
            lo = mid
        else:
            hi = mid
    lam = hi
    tot, mu = _total(lam, groups, g_k)
    p_raw: dict[str, float] = {}
    for d in active:
        p_raw[d.device_id] = p_from_dual(lam, mu.get(d.site_id, 0.0), d.pbar, d.c)
    p_bin = round_binary(p_raw, active)
    if any(d.binary for d in active):
        residual = r - sum(p_bin.values())
        continuous = [d for d in active if not d.binary]
        if continuous and residual > EPS:
            cont_result = solve_qp(residual, continuous, remaining_site_caps(g_k, p_bin, active))
            for did, val in cont_result.p.items():
                p_bin[did] = val
            p_raw = {**p_raw, **cont_result.p_raw}
            lam = cont_result.lam
            mu = {**mu, **cont_result.mu}

    p_q, qloss = quantize_and_repair(p_bin, active, g_k)
    allocated = sum(p_q.values())
    shortfall = max(0.0, r - allocated)
    sites_binding = sum(1 for v in mu.values() if v > EPS)
    return SolveResult(p_q, p_raw, shortfall, lam, mu, qloss, sites_binding)


def remaining_site_caps(
    g_k: dict[str, float],
    allocated: dict[str, float],
    devices: list[DeviceQP],
) -> dict[str, float]:
    used: dict[str, float] = {}
    by_id = {d.device_id: d for d in devices}
    for did, val in allocated.items():
        site = by_id[did].site_id
        used[site] = used.get(site, 0.0) + val
    out: dict[str, float] = {}
    for site_id, g in g_k.items():
        if g == float("inf"):
            out[site_id] = g
        else:
            out[site_id] = max(0.0, g - used.get(site_id, 0.0))
    return out


def round_binary(p: dict[str, float], devices: list[DeviceQP]) -> dict[str, float]:
    out = dict(p)
    for d in devices:
        if not d.binary:
            continue
        val = p.get(d.device_id, 0.0)
        out[d.device_id] = d.pbar if val >= 0.5 * d.pbar else 0.0
    return out


def quantize_and_repair(
    p: dict[str, float],
    devices: list[DeviceQP],
    g_k: dict[str, float],
) -> tuple[dict[str, float], float]:
    by_id = {d.device_id: d for d in devices}
    floored: dict[str, float] = {}
    remainders: list[tuple[float, str]] = []
    for did, val in p.items():
        d = by_id[did]
        q = d.step
        if q <= EPS:
            floored[did] = val
            continue
        n = int(val / q)
        floored[did] = n * q
        remainders.append((val - floored[did], did))
    deficit = sum(p[did] - floored[did] for did in floored)
    remainders.sort(reverse=True)
    site_sum = {d.site_id: 0.0 for d in devices}
    for did, val in floored.items():
        site_sum[by_id[did].site_id] += val
    for _frac, did in remainders:
        d = by_id[did]
        q = d.step
        if q <= EPS or deficit + EPS < q:
            continue
        g = g_k.get(d.site_id, float("inf"))
        if floored[did] + q <= d.pbar + EPS and site_sum[d.site_id] + q <= g + EPS:
            floored[did] += q
            site_sum[d.site_id] += q
            deficit -= q
    qloss = max(0.0, sum(p.values()) - sum(floored.values()))
    return floored, qloss
