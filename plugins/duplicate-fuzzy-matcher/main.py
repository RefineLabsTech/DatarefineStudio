"""Local duplicate and fuzzy-value matcher for DataRefine Studio.

The plugin intentionally operates on one selected column at a time. Preview is
read-only; apply returns one changed Polars frame so the host records the whole
canonicalisation as a normal undoable plugin operation.
"""


def _text(value):
    if value is None:
        return ""
    return str(value)


def _normal(value):
    text = unicodedata.normalize("NFKC", _text(value)).casefold()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _match_normal(value):
    """Normal form used for fuzzy matching, with common name honorifics ignored."""
    tokens = _normal(value).split()
    honorifics = {"md", "mr", "mrs", "ms", "miss", "dr", "prof"}
    if len(tokens) > 1 and tokens[0] in honorifics:
        tokens = tokens[1:]
    return " ".join(tokens)


def _raw_compact(value):
    return re.sub(r"[\W_]+", "", _normal(value))


def _compact(value):
    return re.sub(r"[\W_]+", "", _match_normal(value))


def _soundex(value):
    """Small English-oriented Soundex implementation; non-Latin text is safe."""
    letters = re.sub(r"[^a-z]", "", _normal(value))
    if not letters:
        return ""
    first = letters[0].upper()
    codes = {
        "b": "1", "f": "1", "p": "1", "v": "1",
        "c": "2", "g": "2", "j": "2", "k": "2", "q": "2", "s": "2", "x": "2", "z": "2",
        "d": "3", "t": "3",
        "l": "4",
        "m": "5", "n": "5",
        "r": "6",
    }
    out = []
    previous = ""
    for char in letters[1:]:
        code = codes.get(char, "")
        if code and code != previous:
            out.append(code)
        previous = code
    return (first + "".join(out) + "000")[:4]


def _levenshtein_ratio(a, b):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    previous = list(range(len(a) + 1))
    for j, right in enumerate(b, 1):
        current = [j]
        for i, left in enumerate(a, 1):
            insert_cost = current[i - 1] + 1
            delete_cost = previous[i] + 1
            replace_cost = previous[i - 1] + (0 if left == right else 1)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    distance = previous[-1]
    return 1.0 - (float(distance) / float(max(len(a), len(b))))


def _jaro_winkler(a, b):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    radius = max(len(a), len(b)) // 2 - 1
    if radius < 0:
        radius = 0
    a_matches = [False] * len(a)
    b_matches = [False] * len(b)
    matches = 0
    for i, char in enumerate(a):
        start = max(0, i - radius)
        end = min(i + radius + 1, len(b))
        for j in range(start, end):
            if b_matches[j] or char != b[j]:
                continue
            a_matches[i] = True
            b_matches[j] = True
            matches += 1
            break
    if not matches:
        return 0.0
    a_seen = []
    b_seen = []
    for i, hit in enumerate(a_matches):
        if hit:
            a_seen.append(a[i])
    for j, hit in enumerate(b_matches):
        if hit:
            b_seen.append(b[j])
    transpositions = 0
    for i in range(len(a_seen)):
        if a_seen[i] != b_seen[i]:
            transpositions += 1
    jaro = (
        (float(matches) / len(a))
        + (float(matches) / len(b))
        + ((float(matches) - (transpositions / 2.0)) / matches)
    ) / 3.0
    prefix = 0
    for i in range(min(4, len(a), len(b))):
        if a[i] != b[i]:
            break
        prefix += 1
    return jaro + (prefix * 0.1 * (1.0 - jaro))


def _ngram_ratio(a, b, size=2):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) < size:
        left = {a}
    else:
        left = set(a[i:i + size] for i in range(len(a) - size + 1))
    if len(b) < size:
        right = {b}
    else:
        right = set(b[i:i + size] for i in range(len(b) - size + 1))
    union = left | right
    if not union:
        return 0.0
    return (2.0 * len(left & right)) / float(len(left) + len(right))


def _score(left, right, method):
    left_normal = _normal(left)
    right_normal = _normal(right)
    left_raw_compact = _raw_compact(left)
    right_raw_compact = _raw_compact(right)
    left_compact = _compact(left)
    right_compact = _compact(right)
    if method == "normalized":
        return 1.0 if left_normal == right_normal and left_normal else 0.0
    if left_compact == right_compact and left_compact:
        # A common leading honorific such as "Md." is a strong match signal,
        # but it is shown as slightly less than a literal exact match.
        return 1.0 if left_raw_compact == right_raw_compact else 0.96
    if method == "levenshtein":
        return _levenshtein_ratio(left_compact, right_compact)
    if method == "jaro-winkler":
        return _jaro_winkler(left_compact, right_compact)
    if method == "n-gram":
        return _ngram_ratio(left_compact, right_compact)
    if method == "phonetic":
        left_code = _soundex(left_normal)
        right_code = _soundex(right_normal)
        return 1.0 if left_code and left_code == right_code else 0.0

    # Hybrid is deliberately explainable: edit similarity is the main signal,
    # with Jaro-Winkler and character n-grams helping with short name changes.
    lev = _levenshtein_ratio(left_compact, right_compact)
    jaro = _jaro_winkler(left_compact, right_compact)
    ngram = _ngram_ratio(left_compact, right_compact)
    score = (lev * 0.35) + (jaro * 0.45) + (ngram * 0.20)
    left_code = _soundex(left_normal)
    right_code = _soundex(right_normal)
    if left_code and left_code == right_code:
        score = min(1.0, score + 0.08)
    return score


def _find_column(df, requested):
    wanted = str(requested or "").strip()
    if not wanted:
        raise ValueError("Enter the name of the text column to match.")
    for column in df.columns:
        if str(column) == wanted:
            return str(column)
    folded = wanted.casefold()
    for column in df.columns:
        if str(column).casefold() == folded:
            return str(column)
    available = ", ".join(str(column) for column in df.columns[:25])
    suffix = "" if len(df.columns) <= 25 else ", …"
    raise ValueError("Column '{}' was not found. Available columns: {}{}".format(wanted, available, suffix))


def _number(value, fallback, low, high):
    try:
        number = float(str(value).strip())
    except Exception:
        number = fallback
    return max(low, min(high, number))


def _ignored_groups(value):
    ignored = set()
    for part in re.split(r"[,;\s]+", str(value or "").strip()):
        if not part:
            continue
        try:
            ignored.add(int(part))
        except Exception:
            continue
    return ignored


def _pair_candidates(values):
    """Create manageable candidate pairs for large columns.

    Exact normalized groups are handled separately. For smaller inputs all
    pairs are considered; larger inputs use overlapping prefix/suffix/length
    and phonetic blocks to avoid an accidental quadratic scan.
    """
    count = len(values)
    pairs = set()
    if count <= 1200:
        for left in range(count):
            for right in range(left + 1, count):
                pairs.add((left, right))
        return pairs

    blocks = {}
    for index, value in enumerate(values):
        compact = _compact(value)
        normal = _normal(value)
        keys = [
            "p:" + compact[:3],
            "s:" + compact[-3:],
            "l:" + str(len(compact) // 3),
            "f:" + _soundex(normal),
        ]
        seen = set()
        for key in keys:
            if key in seen or key.endswith(":"):
                continue
            seen.add(key)
            if key not in blocks:
                blocks[key] = []
            blocks[key].append(index)
    for members in blocks.values():
        if len(members) > 350:
            continue
        for left_pos in range(len(members)):
            for right_pos in range(left_pos + 1, len(members)):
                left = members[left_pos]
                right = members[right_pos]
                if left > right:
                    left, right = right, left
                pairs.add((left, right))
    return pairs


def _union(parent, left, right):
    while parent[left] != left:
        parent[left] = parent[parent[left]]
        left = parent[left]
    while parent[right] != right:
        parent[right] = parent[parent[right]]
        right = parent[right]
    if left != right:
        parent[right] = left


def _analyze(df, ctx):
    column = _find_column(df, ctx.get("column"))
    method = str(ctx.get("method") or "hybrid").strip().lower()
    allowed = {"hybrid", "normalized", "levenshtein", "jaro-winkler", "n-gram", "phonetic"}
    if method not in allowed:
        method = "hybrid"
    threshold = _number(ctx.get("threshold"), 90.0, 50.0, 100.0) / 100.0
    minimum = int(_number(ctx.get("min_group_size"), 2.0, 2.0, 100.0))
    max_unique = int(_number(ctx.get("max_unique"), 2000.0, 100.0, 10000.0))

    values = []
    counts = []
    value_index = {}
    for value in df.get_column(column).to_list():
        text = _text(value)
        if not text.strip():
            continue
        if text not in value_index:
            value_index[text] = len(values)
            values.append(text)
            counts.append(0)
        counts[value_index[text]] += 1
    if not values:
        raise ValueError("The selected column has no non-empty values to compare.")
    if len(values) > max_unique:
        raise ValueError(
            "The column has {} distinct non-empty values; the current limit is {}. "
            "Increase Max unique values or use a narrower column.".format(len(values), max_unique)
        )

    parent = list(range(len(values)))
    exact = {}
    for index, value in enumerate(values):
        key = _normal(value)
        if not key:
            continue
        if key not in exact:
            exact[key] = []
        exact[key].append(index)
    for members in exact.values():
        for position in range(1, len(members)):
            _union(parent, members[0], members[position])

    if method != "normalized":
        for left, right in _pair_candidates(values):
            if _score(values[left], values[right], method) >= threshold:
                _union(parent, left, right)

    grouped = {}
    for index in range(len(values)):
        root = parent[index]
        while parent[root] != root:
            parent[root] = parent[parent[root]]
            root = parent[root]
        if root not in grouped:
            grouped[root] = []
        grouped[root].append(index)

    groups = []
    for members in grouped.values():
        total = 0
        for index in members:
            total += counts[index]
        if len(members) < minimum and total < minimum:
            continue
        groups.append({"members": members, "total": total})
    groups.sort(key=lambda item: (-len(item["members"]), -item["total"], item["members"][0]))
    for group_number, group in enumerate(groups, 1):
        group["id"] = group_number
    return {
        "column": column,
        "method": method,
        "threshold": threshold,
        "values": values,
        "counts": counts,
        "groups": groups,
        "ignored": _ignored_groups(ctx.get("ignore_groups")),
    }


def _canonical_index(info, members, ctx):
    mode = str(ctx.get("canonical") or "most_frequent").strip().lower()
    best = members[0]
    if mode == "shortest":
        for index in members[1:]:
            if len(_compact(info["values"][index])) < len(_compact(info["values"][best])):
                best = index
            elif len(_compact(info["values"][index])) == len(_compact(info["values"][best])) and info["counts"][index] > info["counts"][best]:
                best = index
        return best
    if mode == "first_seen":
        return best
    for index in members[1:]:
        if info["counts"][index] > info["counts"][best]:
            best = index
        elif info["counts"][index] == info["counts"][best] and len(info["values"][index]) < len(info["values"][best]):
            best = index
    return best


def _render_preview(info, ctx):
    groups = info["groups"]
    if not groups:
        return (
            "No possible match groups found. Try a lower threshold, a different "
            "method, or a text column with repeated values."
        )
    lines = [
        "Duplicate & Fuzzy Matcher — preview",
        "Column: {} | Method: {} | Threshold: {:.1f}%".format(
            info["column"], info["method"], info["threshold"] * 100.0
        ),
        "Groups are value clusters; scores are similarity to the proposed canonical value, not probabilities.",
        "",
    ]
    shown_groups = 0
    ignored = info["ignored"]
    for group in groups:
        if group["id"] in ignored:
            continue
        canonical = _canonical_index(info, group["members"], ctx)
        lines.append(
            "Possible Match Group #{} · {} variants · {} rows · canonical: {}".format(
                group["id"], len(group["members"]), group["total"], info["values"][canonical]
            )
        )
        ordered = sorted(group["members"], key=lambda index: (-info["counts"][index], index))
        for index in ordered[:12]:
            score = _score(info["values"][canonical], info["values"][index], info["method"]) * 100.0
            marker = "  ← canonical" if index == canonical else ""
            lines.append("  {:6.1f}%  {} ×{}{}".format(score, info["values"][index], info["counts"][index], marker))
        if len(ordered) > 12:
            lines.append("  … {} more variants".format(len(ordered) - 12))
        lines.append("  Apply will replace variants with the canonical text; it will not delete rows.")
        lines.append("")
        shown_groups += 1
        if shown_groups >= 40:
            break
    hidden = len(groups) - shown_groups
    if hidden > 0:
        lines.append("{} more groups are not shown in this bounded preview.".format(hidden))
    if ignored:
        lines.append("Ignored group numbers: {}".format(", ".join(str(x) for x in sorted(ignored))))
    return "\n".join(lines).strip()


def preview(df, ctx):
    return _render_preview(_analyze(df, ctx), ctx)


def apply(df, ctx):
    info = _analyze(df, ctx)
    mapping = {}
    for group in info["groups"]:
        if group["id"] in info["ignored"]:
            continue
        canonical = _canonical_index(info, group["members"], ctx)
        canonical_text = info["values"][canonical]
        for index in group["members"]:
            mapping[info["values"][index]] = canonical_text

    source = df.get_column(info["column"]).to_list()
    output = []
    changed = False
    for value in source:
        if value is None:
            output.append(None)
            continue
        text = str(value)
        replacement = mapping.get(text, text)
        if replacement != text:
            changed = True
        output.append(replacement)
    if not changed:
        return df
    # A text-cleaning operation intentionally returns a text column. Nulls are
    # preserved, and the host records this as one normal undoable operation.
    return df.with_columns(pl.Series(name=info["column"], values=output, dtype=pl.Utf8))
