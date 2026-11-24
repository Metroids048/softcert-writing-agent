"""Partition consecutive, non-empty rows with a per-page minimum."""
from itertools import accumulate
from bisect import bisect_right, bisect_left


def balanced_slices(heights, minimum, capacity, effective=None):
    """Find a valid full partition, keeping each input unit intact.

    If there is no valid partition, return None so the caller can keep a draft
    and ask for material. A wrap in source counts once, regardless of height.
    """
    rows = [0, *accumulate(heights)]
    counts = [0, *accumulate(effective if effective is not None else [1] * len(heights))]
    following = {len(heights): None}
    for start in range(len(heights) - 1, -1, -1):
        first = bisect_left(counts, counts[start] + minimum, lo=start + 1)
        last = bisect_right(rows, rows[start] + capacity, lo=start + 1) - 1
        for end in range(last, first - 1, -1):
            if end in following:
                following[start] = end
                break
    if not heights or 0 not in following:
        return None
    sections = []
    start = 0
    while start < len(heights):
        end = following[start]
        sections.append((start, end))
        start = end
    return sections
