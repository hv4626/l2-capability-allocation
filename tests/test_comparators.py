from l0_foundation.comparators import compare


def test_comparators():
    assert compare(0.9, ">", 0.85)
    assert not compare(0.85, ">", 0.85)
    assert compare(0.85, ">=", 0.85)
    assert compare(0.4, "<", 0.5)
    assert compare(0.5, "<=", 0.5)
    assert compare(1.0, "==", 1.0)
    assert compare(1.0, "!=", 0.0)
    assert not compare(1.0, "==", 0.0)
