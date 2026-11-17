"""Tests for nf_engine: hand-checked examples plus seeded randomised checks against
brute-force implementations of the textbook definitions."""

from __future__ import annotations

import random
import sys
from itertools import combinations
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nf_engine import (  # noqa: E402
    candidate_keys,
    closure,
    highest_normal_form,
    is_2nf,
    is_3nf,
    is_bcnf,
    is_lossless,
    parse_fds,
    partial_dependencies,
    prime_attributes,
    transitive_dependencies,
)

# ---------------------------------------------------------------- hand-checked examples

ORDER_LINE = ["order_id", "product_id", "quantity", "product_name"]
ORDER_LINE_FDS = parse_fds("order_id, product_id -> quantity; product_id -> product_name")

EMPLOYEE = ["emp_id", "dept_id", "dept_city"]
EMPLOYEE_FDS = parse_fds("emp_id -> dept_id; dept_id -> dept_city")

TEACHING = ["student", "course", "instructor"]
TEACHING_FDS = parse_fds("student, course -> instructor; instructor -> course")


def test_parse_fds():
    assert parse_fds("A, B -> C, D; C -> E\nE->A") == [
        (("A", "B"), ("C", "D")),
        (("C",), ("E",)),
        (("E",), ("A",)),
    ]
    with pytest.raises(ValueError):
        parse_fds("A B C")
    with pytest.raises(ValueError):
        parse_fds("-> C")


def test_closure():
    fds = parse_fds("A -> B; B -> C; C, D -> E")
    assert closure(["A"], fds) == {"A", "B", "C"}
    assert closure(["A", "D"], fds) == {"A", "B", "C", "D", "E"}
    assert closure([], fds) == set()


def test_candidate_keys_single_and_composite():
    assert candidate_keys(ORDER_LINE, ORDER_LINE_FDS) == [("order_id", "product_id")]
    assert candidate_keys(EMPLOYEE, EMPLOYEE_FDS) == [("emp_id",)]


def test_candidate_keys_multiple():
    fds = parse_fds("A, B -> C; C -> D; D -> A")
    assert candidate_keys(["A", "B", "C", "D"], fds) == [("A", "B"), ("B", "C"), ("B", "D")]
    assert prime_attributes(["A", "B", "C", "D"], fds) == {"A", "B", "C", "D"}


def test_no_fds_means_whole_relation_is_the_key():
    assert candidate_keys(["A", "B"], []) == [("A", "B")]
    assert highest_normal_form(["A", "B"], []) == "BCNF"


def test_partial_dependency_breaks_2nf():
    assert partial_dependencies(ORDER_LINE, ORDER_LINE_FDS, ("order_id", "product_id")) == [
        (("product_id",), ("product_name",))
    ]
    assert not is_2nf(ORDER_LINE, ORDER_LINE_FDS)
    assert highest_normal_form(ORDER_LINE, ORDER_LINE_FDS) == "1NF"


def test_transitive_dependency_breaks_3nf():
    assert transitive_dependencies(EMPLOYEE, EMPLOYEE_FDS) == [(("dept_id",), ("dept_city",))]
    assert is_2nf(EMPLOYEE, EMPLOYEE_FDS)
    assert not is_3nf(EMPLOYEE, EMPLOYEE_FDS)
    assert highest_normal_form(EMPLOYEE, EMPLOYEE_FDS) == "2NF"


def test_transitive_dependency_with_composite_determinant():
    rel = ["id", "w", "x", "y", "z"]
    fds = parse_fds("id -> w, x, y, z; w, x, y -> z")
    assert transitive_dependencies(rel, fds) == [(("w", "x", "y"), ("z",))]


def test_3nf_but_not_bcnf():
    assert candidate_keys(TEACHING, TEACHING_FDS) == [("student", "course"), ("student", "instructor")]
    assert is_3nf(TEACHING, TEACHING_FDS)
    assert not is_bcnf(TEACHING, TEACHING_FDS)
    assert highest_normal_form(TEACHING, TEACHING_FDS) == "3NF"


def test_bcnf():
    fds = parse_fds("customer_id -> name, email; email -> customer_id")
    assert highest_normal_form(["customer_id", "name", "email"], fds) == "BCNF"


def test_lossless_decomposition():
    good = [["emp_id", "dept_id"], ["dept_id", "dept_city"]]
    bad = [["emp_id", "dept_city"], ["dept_id", "dept_city"]]
    assert is_lossless(EMPLOYEE, good, EMPLOYEE_FDS)
    assert not is_lossless(EMPLOYEE, bad, EMPLOYEE_FDS)
    with pytest.raises(ValueError):
        is_lossless(EMPLOYEE, [["emp_id"]], EMPLOYEE_FDS)


def test_lossless_three_way():
    rel = ["A", "B", "C", "D"]
    fds = parse_fds("A -> B; B -> C; C -> D")
    assert is_lossless(rel, [["A", "B"], ["B", "C"], ["C", "D"]], fds)
    assert not is_lossless(rel, [["A", "B"], ["C", "D"]], fds)


# ---------------------------------------------------------------- brute-force oracles

def subsets(attrs):
    for size in range(len(attrs) + 1):
        yield from combinations(attrs, size)


def oracle_keys(rel, fds):
    supers = [set(s) for s in subsets(rel) if closure(s, fds) >= set(rel)]
    return sorted(
        (tuple(a for a in rel if a in s) for s in supers if not any(o < s for o in supers)),
        key=lambda k: (len(k), [rel.index(a) for a in k]),
    )


def oracle_bcnf(rel, fds):
    # Every X whose closure adds something must be a superkey.
    return all(closure(x, fds) & set(rel) == set(x) or closure(x, fds) >= set(rel) for x in subsets(rel))


def oracle_3nf(rel, fds):
    prime = {a for k in oracle_keys(rel, fds) for a in k}
    for x in subsets(rel):
        added = (closure(x, fds) & set(rel)) - set(x)
        if added and not closure(x, fds) >= set(rel) and not added <= prime:
            return False
    return True


def oracle_2nf(rel, fds):
    keys = oracle_keys(rel, fds)
    prime = {a for k in keys for a in k}
    for key in keys:
        for size in range(1, len(key)):
            for part in combinations(key, size):
                if (closure(part, fds) & set(rel)) - prime - set(part):
                    return False
    return True


def random_case(rng):
    n = rng.randint(2, 6)
    rel = [chr(ord("A") + i) for i in range(n)]
    fds = []
    for _ in range(rng.randint(0, 5)):
        lhs = tuple(sorted(rng.sample(rel, rng.randint(1, min(3, n)))))
        rhs = tuple(sorted(rng.sample(rel, rng.randint(1, 2))))
        fds.append((lhs, rhs))
    return rel, fds


RANDOM_CASES = 400


@pytest.mark.parametrize("seed", range(RANDOM_CASES))
def test_random_against_definitions(seed):
    rng = random.Random(seed)
    rel, fds = random_case(rng)
    assert candidate_keys(rel, fds) == oracle_keys(rel, fds)
    assert is_bcnf(rel, fds) == oracle_bcnf(rel, fds)
    assert is_3nf(rel, fds) == oracle_3nf(rel, fds)
    assert is_2nf(rel, fds) == oracle_2nf(rel, fds)
    # BCNF implies 3NF implies 2NF
    assert not is_bcnf(rel, fds) or is_3nf(rel, fds)
    assert not is_3nf(rel, fds) or is_2nf(rel, fds)


@pytest.mark.parametrize("seed", range(RANDOM_CASES))
def test_random_binary_decomposition(seed):
    # Theorem: R1, R2 is lossless iff (R1 & R2) -> R1 or (R1 & R2) -> R2.
    rng = random.Random(10_000 + seed)
    rel, fds = random_case(rng)
    while len(rel) < 3:  # a binary decomposition needs at least three attributes
        rel, fds = random_case(rng)
    common = set(rng.sample(rel, rng.randint(0, len(rel) - 2)))
    rest = [a for a in rel if a not in common]
    rng.shuffle(rest)
    cut = rng.randint(1, len(rest) - 1)
    r1 = [a for a in rel if a in common or a in rest[:cut]]
    r2 = [a for a in rel if a in common or a in rest[cut:]]
    expected = closure(common, fds) >= set(r1) or closure(common, fds) >= set(r2)
    assert is_lossless(rel, [r1, r2], fds) == expected
