"""Balance the pinned Skill's pages and apply verified source-scope ranges."""
import compose_code
import json
import sys
from pathlib import Path
from pagination import balanced_slices

original_paginate = compose_code.paginate
compact_layout = "--compact-layout" in sys.argv[1:]
capacity_limit = 76 if compact_layout else 66


def scoped_collector(ranges):
    collect = compose_code.collect_lines
    read_text = compose_code.safe_text
    by_path = {}
    for item in ranges:
        by_path.setdefault(item["path"], []).append(item)

    def collect_scoped(root, files, max_chars):
        excluded = 0

        def scoped_text(path, **kwargs):
            nonlocal excluded
            text = read_text(path, **kwargs)
            selected = by_path.get(path.relative_to(root).as_posix(), [])
            if not selected:
                return text
            lines = text.splitlines(keepends=True)
            original_hash = compose_code.sha256_file(path)
            for item in selected:
                first, last = item["first"], item["last"]
                if item["sha256"] != original_hash or not 1 <= first <= last <= len(lines):
                    raise ValueError(f"Invalid source range: {path}:{first}–{last}")
                for index in range(first - 1, last):
                    excluded += bool(lines[index].strip())
                    lines[index] = "\n"
            return "".join(lines)

        compose_code.safe_text = scoped_text
        try:
            lines, mapping, records, blanks = collect(root, files, max_chars)
        finally:
            compose_code.safe_text = read_text
        return lines, mapping, records, blanks - excluded

    return collect_scoped


def paginate(lines, mapping, per_page):
    pages, grid = original_paginate(lines, mapping, per_page)
    groups = compose_code.group_logical_lines(lines, mapping)
    if not groups or not pages:
        return pages, grid
    last_count = sum(item["segment"] == 1 for item in mapping[len(lines) - len(pages[-1]):])
    if last_count >= 50 and grid <= capacity_limit:
        return pages, grid
    heights = [len(group) for group in groups]
    # Keep the existing grid when possible. Slightly tighten leading only
    # when needed, retaining readable type and complete wrapped source lines.
    for capacity in range(min(grid, capacity_limit), capacity_limit + 1):
        slices = balanced_slices(heights, max(50, per_page), capacity)
        if slices:
            return [[line for group in groups[start:end] for line in group]
                    for start, end in slices], capacity
    return pages, grid


if __name__ == "__main__":
    if compact_layout:
        sys.argv.remove("--compact-layout")
        sys.argv.extend(["--font-size", "8", "--max-chars", "98"])
    compose_code.DEFAULT_EXTENSIONS |= {".sh", ".css", ".scss", ".sass", ".less", ".svelte"}
    manifest = Path(sys.argv[sys.argv.index("--manifest") + 1])
    ranges = json.loads(manifest.read_text(encoding="utf-8")).get("line_exclusions", [])
    if ranges:
        compose_code.collect_lines = scoped_collector(ranges)
    compose_code.paginate = paginate
    compose_code.main()
