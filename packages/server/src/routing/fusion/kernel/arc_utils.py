"""Grid helpers available to kernel-executed programs (`from arc_utils import *`).

Grids are lists of lists of ints (0 is usually background). Every helper is
pure and returns new lists; nothing here depends on third-party packages.
"""

from collections import Counter, deque
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

Grid = List[List[int]]
Point = Tuple[int, int]

__all__ = [
    "Grid", "Point", "copy_grid", "dims", "new_grid", "transpose", "flip_h", "flip_v",
    "rotate_cw", "rotate_ccw", "rotate_180", "all_symmetries", "crop", "paste", "translate",
    "colors", "color_counts", "most_common_color", "background_color", "cells_of_color",
    "replace_color", "bbox", "bbox_of_color", "flood_fill", "connected_components", "objects",
    "component_bbox", "extract", "mask", "overlay", "tile", "scale_up", "scale_down",
    "find_subgrid", "equal", "rows_equal", "cols_equal", "is_symmetric_h", "is_symmetric_v",
    "neighbors4", "neighbors8", "in_bounds", "argmax_component", "hollow", "outline",
]


def copy_grid(g: Grid) -> Grid:
    return [list(r) for r in g]


def dims(g: Grid) -> Tuple[int, int]:
    return (len(g), len(g[0]) if g else 0)


def new_grid(h: int, w: int, fill: int = 0) -> Grid:
    return [[fill] * w for _ in range(h)]


def transpose(g: Grid) -> Grid:
    return [list(r) for r in zip(*g)] if g else []


def flip_h(g: Grid) -> Grid:
    """Mirror left-right."""
    return [list(reversed(r)) for r in g]


def flip_v(g: Grid) -> Grid:
    """Mirror top-bottom."""
    return [list(r) for r in reversed(g)]


def rotate_cw(g: Grid) -> Grid:
    return [list(r) for r in zip(*g[::-1])] if g else []


def rotate_ccw(g: Grid) -> Grid:
    return [list(r) for r in zip(*g)][::-1] if g else []


def rotate_180(g: Grid) -> Grid:
    return [list(reversed(r)) for r in reversed(g)]


def all_symmetries(g: Grid) -> List[Grid]:
    """The 8 dihedral images of g (identity first)."""
    out = [copy_grid(g), rotate_cw(g), rotate_180(g), rotate_ccw(g)]
    t = transpose(g)
    out += [t, rotate_cw(t), rotate_180(t), rotate_ccw(t)]
    return out


def crop(g: Grid, r0: int, c0: int, r1: int, c1: int) -> Grid:
    """Sub-grid rows r0..r1 and cols c0..c1, inclusive."""
    return [row[c0:c1 + 1] for row in g[r0:r1 + 1]]


def paste(base: Grid, patch: Grid, r: int, c: int, transparent: Optional[int] = None) -> Grid:
    """Copy `patch` onto `base` at (r, c); cells equal to `transparent` are skipped."""
    out = copy_grid(base)
    h, w = dims(out)
    for i, row in enumerate(patch):
        for j, v in enumerate(row):
            if transparent is not None and v == transparent:
                continue
            if 0 <= r + i < h and 0 <= c + j < w:
                out[r + i][c + j] = v
    return out


def translate(g: Grid, dr: int, dc: int, fill: int = 0) -> Grid:
    h, w = dims(g)
    out = new_grid(h, w, fill)
    for i in range(h):
        for j in range(w):
            if 0 <= i + dr < h and 0 <= j + dc < w:
                out[i + dr][j + dc] = g[i][j]
    return out


def colors(g: Grid) -> List[int]:
    return sorted({v for row in g for v in row})


def color_counts(g: Grid) -> Dict[int, int]:
    return dict(Counter(v for row in g for v in row))


def most_common_color(g: Grid, exclude: Iterable[int] = ()) -> int:
    ex = set(exclude)
    counts = [(n, c) for c, n in color_counts(g).items() if c not in ex]
    return max(counts)[1] if counts else 0


def background_color(g: Grid) -> int:
    return most_common_color(g)


def cells_of_color(g: Grid, color: int) -> List[Point]:
    return [(i, j) for i, row in enumerate(g) for j, v in enumerate(row) if v == color]


def replace_color(g: Grid, mapping: Dict[int, int]) -> Grid:
    return [[mapping.get(v, v) for v in row] for row in g]


def bbox(points: Sequence[Point]) -> Tuple[int, int, int, int]:
    """(r0, c0, r1, c1) inclusive bounding box of points."""
    rs = [p[0] for p in points]
    cs = [p[1] for p in points]
    return (min(rs), min(cs), max(rs), max(cs))


def bbox_of_color(g: Grid, color: int) -> Optional[Tuple[int, int, int, int]]:
    pts = cells_of_color(g, color)
    return bbox(pts) if pts else None


def in_bounds(g: Grid, r: int, c: int) -> bool:
    return 0 <= r < len(g) and 0 <= c < len(g[0])


def neighbors4(r: int, c: int) -> List[Point]:
    return [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)]


def neighbors8(r: int, c: int) -> List[Point]:
    return [(r + dr, c + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)]


def flood_fill(g: Grid, r: int, c: int, color: int, diagonal: bool = False) -> Grid:
    """Fill the 4/8-connected region containing (r, c) with `color`."""
    out = copy_grid(g)
    target = out[r][c]
    if target == color:
        return out
    nb = neighbors8 if diagonal else neighbors4
    q = deque([(r, c)])
    out[r][c] = color
    while q:
        cr, cc = q.popleft()
        for nr, nc in nb(cr, cc):
            if in_bounds(out, nr, nc) and out[nr][nc] == target:
                out[nr][nc] = color
                q.append((nr, nc))
    return out


def connected_components(g: Grid, background: Optional[int] = None, diagonal: bool = False, by_color: bool = True) -> List[Dict]:
    """Components of non-background cells.

    Each component: {"color": int or None, "cells": [(r, c), ...], "bbox": (r0, c0, r1, c1), "size": int}.
    by_color=True keeps components single-colored; False merges touching colors.
    """
    if background is None:
        background = background_color(g)
    h, w = dims(g)
    seen = [[False] * w for _ in range(h)]
    nb = neighbors8 if diagonal else neighbors4
    comps: List[Dict] = []
    for i in range(h):
        for j in range(w):
            if seen[i][j] or g[i][j] == background:
                continue
            color = g[i][j]
            cells = []
            q = deque([(i, j)])
            seen[i][j] = True
            while q:
                r, c = q.popleft()
                cells.append((r, c))
                for nr, nc in nb(r, c):
                    if in_bounds(g, nr, nc) and not seen[nr][nc] and g[nr][nc] != background and (not by_color or g[nr][nc] == color):
                        seen[nr][nc] = True
                        q.append((nr, nc))
            comps.append({"color": color if by_color else None, "cells": cells, "bbox": bbox(cells), "size": len(cells)})
    comps.sort(key=lambda comp: (comp["bbox"][0], comp["bbox"][1]))
    return comps


objects = connected_components


def component_bbox(comp: Dict) -> Tuple[int, int, int, int]:
    return comp["bbox"]


def extract(g: Grid, comp_or_bbox, background: int = 0) -> Grid:
    """Sub-grid of a component (other cells set to background) or of a bbox."""
    if isinstance(comp_or_bbox, dict):
        r0, c0, r1, c1 = comp_or_bbox["bbox"]
        out = new_grid(r1 - r0 + 1, c1 - c0 + 1, background)
        for r, c in comp_or_bbox["cells"]:
            out[r - r0][c - c0] = g[r][c]
        return out
    r0, c0, r1, c1 = comp_or_bbox
    return crop(g, r0, c0, r1, c1)


def mask(g: Grid, color: int) -> List[List[bool]]:
    return [[v == color for v in row] for row in g]


def overlay(bottom: Grid, top: Grid, transparent: int = 0) -> Grid:
    """Cell-wise: top over bottom where top != transparent (same dims)."""
    return [[t if t != transparent else b for b, t in zip(br, tr)] for br, tr in zip(bottom, top)]


def tile(g: Grid, reps_r: int, reps_c: int) -> Grid:
    return [list(row) * reps_c for _ in range(reps_r) for row in g]


def scale_up(g: Grid, k: int) -> Grid:
    return [[v for v in row for _ in range(k)] for row in g for _ in range(k)]


def scale_down(g: Grid, k: int) -> Grid:
    return [row[::k] for row in g[::k]]


def find_subgrid(g: Grid, pattern: Grid, wildcard: Optional[int] = None) -> List[Point]:
    """Top-left positions where `pattern` occurs (wildcard cells match anything)."""
    h, w = dims(g)
    ph, pw = dims(pattern)
    hits = []
    for r in range(h - ph + 1):
        for c in range(w - pw + 1):
            ok = True
            for i in range(ph):
                for j in range(pw):
                    pv = pattern[i][j]
                    if pv != wildcard and g[r + i][c + j] != pv:
                        ok = False
                        break
                if not ok:
                    break
            if ok:
                hits.append((r, c))
    return hits


def equal(a: Grid, b: Grid) -> bool:
    return [list(r) for r in a] == [list(r) for r in b]


def rows_equal(g: Grid, i: int, j: int) -> bool:
    return list(g[i]) == list(g[j])


def cols_equal(g: Grid, i: int, j: int) -> bool:
    return [row[i] for row in g] == [row[j] for row in g]


def is_symmetric_h(g: Grid) -> bool:
    return equal(g, flip_h(g))


def is_symmetric_v(g: Grid) -> bool:
    return equal(g, flip_v(g))


def argmax_component(comps: List[Dict], key: str = "size") -> Optional[Dict]:
    return max(comps, key=lambda c: c[key]) if comps else None


def hollow(g: Grid, background: int = 0) -> Grid:
    """Keep only cells that touch the background (4-neighbourhood) or the border."""
    h, w = dims(g)
    out = copy_grid(g)
    for i in range(h):
        for j in range(w):
            if g[i][j] == background:
                continue
            interior = all(in_bounds(g, r, c) and g[r][c] != background for r, c in neighbors4(i, j))
            if interior:
                out[i][j] = background
    return out


def outline(g: Grid, color: int, background: int = 0) -> Grid:
    """Background cells 4-adjacent to a non-background cell, painted `color`."""
    h, w = dims(g)
    out = copy_grid(g)
    for i in range(h):
        for j in range(w):
            if g[i][j] == background and any(in_bounds(g, r, c) and g[r][c] != background for r, c in neighbors4(i, j)):
                out[i][j] = color
    return out
