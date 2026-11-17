"""Functional-dependency toolkit: attribute closure, candidate keys, and 2NF / 3NF / BCNF checks.

Attributes are strings; a functional dependency (FD) is a pair ``(lhs, rhs)`` of attribute
sequences. ``parse_fds`` builds them from text:

    >>> fds = parse_fds("order_id, product_id -> quantity; product_id -> product_name")
    >>> candidate_keys(["order_id", "product_id", "quantity", "product_name"], fds)
    [('order_id', 'product_id')]
    >>> highest_normal_form(["order_id", "product_id", "quantity", "product_name"], fds)
    '1NF'

The algorithms enumerate attribute subsets, so the cost grows as 2^n in the number of
attributes. That is fine for schema-design-sized relations (up to roughly 15 attributes).
The relation is assumed to already be in 1NF (atomic values).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from itertools import combinations

FD = tuple[tuple[str, ...], tuple[str, ...]]

__all__ = [
    "FD",
    "parse_fds",
    "closure",
    "is_superkey",
    "candidate_keys",
    "prime_attributes",
    "project_fds",
    "partial_dependencies",
    "transitive_dependencies",
    "is_2nf",
    "is_3nf",
    "is_bcnf",
    "highest_normal_form",
    "is_lossless",
]


def parse_fds(text: str) -> list[FD]:
    """Parse ``"A, B -> C, D; C -> E"`` into ``[(("A", "B"), ("C", "D")), (("C",), ("E",))]``."""
    fds: list[FD] = []
    for part in text.replace("\n", ";").split(";"):
        if not part.strip():
            continue
        if "->" not in part:
            raise ValueError(f"not a functional dependency (missing '->'): {part.strip()!r}")
        lhs, rhs = part.split("->", 1)
        left = tuple(a.strip() for a in lhs.split(",") if a.strip())
        right = tuple(a.strip() for a in rhs.split(",") if a.strip())
        if not left or not right:
            raise ValueError(f"empty side in functional dependency: {part.strip()!r}")
        fds.append((left, right))
    return fds


def closure(attrs: Iterable[str], fds: Sequence[FD]) -> set[str]:
    """Attribute closure X+: every attribute functionally determined by ``attrs``."""
    result = set(attrs)
    changed = True
    while changed:
        changed = False
        for lhs, rhs in fds:
            if set(lhs) <= result and not set(rhs) <= result:
                result |= set(rhs)
                changed = True
    return result


def is_superkey(attrs: Iterable[str], relation: Sequence[str], fds: Sequence[FD]) -> bool:
    return closure(attrs, fds) >= set(relation)


def candidate_keys(relation: Sequence[str], fds: Sequence[FD]) -> list[tuple[str, ...]]:
    """All candidate keys (minimal superkeys), smallest first, attributes in relation order."""
    relation = list(relation)
    keys: list[tuple[str, ...]] = []
    for size in range(1, len(relation) + 1):
        for combo in combinations(relation, size):
            if any(set(k) <= set(combo) for k in keys):
                continue  # contains a smaller key, so it is not minimal
            if is_superkey(combo, relation, fds):
                keys.append(combo)
    return keys


def prime_attributes(relation: Sequence[str], fds: Sequence[FD]) -> set[str]:
    """Attributes that belong to at least one candidate key."""
    return {a for key in candidate_keys(relation, fds) for a in key}


def project_fds(sub: Sequence[str], fds: Sequence[FD]) -> list[FD]:
    """FDs that hold on the attribute subset ``sub``, with minimal left-hand sides.

    For every X within ``sub`` this yields X -> (X+ restricted to ``sub``) minus X, after
    removing attributes that a smaller left-hand side already determines.
    """
    sub = list(sub)
    out: list[FD] = []
    for size in range(1, len(sub)):
        for lhs in combinations(sub, size):
            rhs = (closure(lhs, fds) & set(sub)) - set(lhs)
            for smaller, determined in out:
                if set(smaller) < set(lhs):
                    rhs -= set(determined)
            if rhs:
                out.append((lhs, tuple(a for a in sub if a in rhs)))
    return out


def partial_dependencies(relation: Sequence[str], fds: Sequence[FD], key: Sequence[str]) -> list[FD]:
    """Non-prime attributes that depend on a proper subset of ``key`` (2NF violations)."""
    if len(key) < 2:
        return []
    prime = prime_attributes(relation, fds)
    found: list[FD] = []
    for size in range(1, len(key)):
        for part in combinations(key, size):
            reached = closure(part, fds)
            dep = tuple(
                a for a in relation
                if a not in prime and a in reached and not any(a in d for _, d in found)
            )
            if dep:
                found.append((part, dep))
    return found


def transitive_dependencies(relation: Sequence[str], fds: Sequence[FD]) -> list[FD]:
    """Non-prime attributes determined by a set of other non-prime attributes that is not a
    superkey (3NF violations of the classic "key -> X -> A" form)."""
    prime = prime_attributes(relation, fds)
    nonprime = [a for a in relation if a not in prime]
    found: list[FD] = []
    for size in range(1, len(nonprime) + 1):
        for det in combinations(nonprime, size):
            reached = closure(det, fds)
            if reached >= set(relation):
                continue
            dep = tuple(
                a for a in nonprime
                if a not in det and a in reached and not any(a in d for _, d in found)
            )
            if dep:
                found.append((det, dep))
    return found


def is_2nf(relation: Sequence[str], fds: Sequence[FD]) -> bool:
    """No non-prime attribute depends on a proper subset of any candidate key."""
    return all(not partial_dependencies(relation, fds, key) for key in candidate_keys(relation, fds))


def is_3nf(relation: Sequence[str], fds: Sequence[FD]) -> bool:
    """For every non-trivial X -> A: X is a superkey or A is prime."""
    prime = prime_attributes(relation, fds)
    return all(
        is_superkey(lhs, relation, fds) or set(rhs) <= prime
        for lhs, rhs in project_fds(relation, fds)
    )


def is_bcnf(relation: Sequence[str], fds: Sequence[FD]) -> bool:
    """For every non-trivial X -> A: X is a superkey."""
    return all(is_superkey(lhs, relation, fds) for lhs, _ in project_fds(relation, fds))


def highest_normal_form(relation: Sequence[str], fds: Sequence[FD]) -> str:
    """'1NF', '2NF', '3NF' or 'BCNF'."""
    if not is_2nf(relation, fds):
        return "1NF"
    if not is_3nf(relation, fds):
        return "2NF"
    if not is_bcnf(relation, fds):
        return "3NF"
    return "BCNF"


def is_lossless(relation: Sequence[str], parts: Sequence[Sequence[str]], fds: Sequence[FD]) -> bool:
    """Chase test: does joining ``parts`` back together always give exactly the original relation?"""
    relation = list(relation)
    missing = set(relation) - {a for p in parts for a in p}
    if missing:
        raise ValueError(f"decomposition drops attributes: {sorted(missing)}")
    # Tableau: one row per part; ('a', attr) is a distinguished symbol, ('b', row, attr) is not.
    rows = [
        {a: ("a", a) if a in part else ("b", i, a) for a in relation}
        for i, part in enumerate(parts)
    ]
    changed = True
    while changed:
        changed = False
        for lhs, rhs in fds:
            if not set(lhs) <= set(relation):
                continue
            for i in range(len(rows)):
                for j in range(i + 1, len(rows)):
                    if all(rows[i][a] == rows[j][a] for a in lhs):
                        for a in rhs:
                            if a not in rows[i]:
                                continue
                            x, y = rows[i][a], rows[j][a]
                            if x != y:
                                keep = x if x[0] == "a" else y if y[0] == "a" else min(x, y)
                                for row in rows:
                                    if row[a] in (x, y):
                                        row[a] = keep
                                changed = True
    return any(all(row[a] == ("a", a) for a in relation) for row in rows)
