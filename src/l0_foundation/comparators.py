from __future__ import annotations

COMPARATORS = (">", ">=", "<", "<=", "==", "!=")


def compare(value: float, comparator: str, threshold: float) -> bool:
    if comparator == ">":
        return value > threshold
    if comparator == ">=":
        return value >= threshold
    if comparator == "<":
        return value < threshold
    if comparator == "<=":
        return value <= threshold
    if comparator == "==":
        return value == threshold
    if comparator == "!=":
        return value != threshold
    raise ValueError(f"unsupported comparator: {comparator!r}")
