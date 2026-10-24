"""Offline, bounded preparation of one PatentsView annualized CSV ZIP."""
import argparse, csv, hashlib, json, os, stat, sys, zipfile
from pathlib import Path

DICT_SHA = "6ce4cd95e622caea96bd5b3ce56a4f95015c71ab7a146286e278c39d1ebf1923"
REQUIRED = {"patent_number", "grant_year", "application_number", "application_year", "assignee",
            "assignee_ind", "assignee_sequence", "city", "state", "country", "county",
            "cpc_sections", "ipc_sections", "wipo_field_ids", "first_wipo_field_title",
            "first_wipo_sector_title", "team_size"}
INVENTORS = {f"inventor_{kind}{i}" for i in range(1, 11) for kind in ("id", "name")}
MAX_ZIP = 64 * 1024 * 1024
MAX_CSV = 256 * 1024 * 1024
MAX_RATIO = 250
MAX_ROWS = 10_000_000
MAX_FIELD = 200_000
CHUNK_ROWS = 1000
CHUNK_CHARS = 1_000_000
EXPECTED = REQUIRED | INVENTORS | {"d_inventor","d_assignee","d_location","d_application","d_cpc","d_ipc","d_wipo","n_cpc","n_ipc","n_wipo","inventors","men_inventors","women_inventors","wipo_sector_title9","wipo_field_title9"} | {f"male_flag{i}" for i in range(1,11)}

def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def clean(value):
    value = value or ""
    if len(value) > MAX_FIELD: raise ValueError("CSV field exceeds safety cap")
    return value

def member(zip_path, year):
    if os.path.getsize(zip_path) > MAX_ZIP: raise ValueError("ZIP exceeds safety cap")
    with zipfile.ZipFile(zip_path) as archive:
        if len(archive.infolist()) > 10: raise ValueError("ZIP member count exceeds safety cap")
        candidates = []
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"): raise ValueError("ZIP contains an unsafe member path")
            if info.is_dir(): continue
            if stat.S_ISLNK(info.external_attr >> 16): raise ValueError("ZIP symlinks are forbidden")
            if Path(name).name == f"{year}.csv": candidates.append(info)
        if len(candidates) != 1: raise ValueError("ZIP must contain exactly one selected YYYY.csv")
        info = candidates[0]
        if info.file_size > MAX_CSV or info.compress_size <= 0 or info.file_size / info.compress_size > MAX_RATIO:
            raise ValueError("CSV expansion exceeds safety cap")
        return info.filename, info.file_size

def prepare(args):
    if args.dictionary_sha256 != DICT_SHA: raise ValueError("Dictionary hash mismatch")
    zip_sha = sha_file(args.zip)
    if args.expected_zip_sha256 and zip_sha != args.expected_zip_sha256: raise ValueError("ZIP hash mismatch")
    selected, declared_bytes = member(args.zip, args.year)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=False)
    chunks, rows, chars, index, patent_numbers = [], [], 0, 0, set()
    def flush():
        nonlocal rows, chars, index
        if not rows: return
        data = "".join(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n" for row in rows).encode()
        name = f"chunk-{index:06d}.jsonl"; path = out / name
        start = sum(c["rows"] for c in chunks) + 1
        path.write_bytes(data); chunks.append({"name": name, "rows": len(rows), "row_start":start,"row_end":start+len(rows)-1,"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        rows, chars, index = [], 0, index + 1
    with zipfile.ZipFile(args.zip) as archive, archive.open(selected) as raw:
        import io
        csv_hash = hashlib.sha256()
        with archive.open(selected) as hash_source:
            for block in iter(lambda: hash_source.read(1024 * 1024), b""): csv_hash.update(block)
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="strict", newline="")
        reader = csv.DictReader(text)
        header = reader.fieldnames or []
        if len(header) != len(set(header)): raise ValueError("CSV header contains duplicate columns")
        fields = set(header)
        if fields != EXPECTED: raise ValueError("CSV header does not match the grants2025 dictionary projection")
        for number, source in enumerate(reader, 1):
            if number > MAX_ROWS: raise ValueError("CSV row cap exceeded")
            if None in source or any(value is None for value in source.values()): raise ValueError("CSV row column count is malformed")
            patent = clean(source["patent_number"]).strip()
            if not patent: raise ValueError("patent_number is required")
            if clean(source["grant_year"]).strip() != str(args.year): raise ValueError("grant_year differs from selected annual cohort")
            patent_numbers.add(patent)
            row = {key: clean(source.get(key, "")).strip() for key in sorted(REQUIRED)}
            row["inventors"] = [{"id": clean(source.get(f"inventor_id{i}", "")).strip(),
                                  "name": clean(source.get(f"inventor_name{i}", "")).strip(), "position": i}
                                 for i in range(1, 11) if source.get(f"inventor_id{i}") or source.get(f"inventor_name{i}")]
            row["missing_flags"] = {key: clean(value).strip() for key, value in source.items() if key.startswith("d_")}
            row["uninterpreted_fields"] = {key: clean(source.get(key, "")).strip() for key in ("wipo_sector_title9", "wipo_field_title9") if key in fields}
            encoded = len(json.dumps(row, ensure_ascii=False)) + 1
            if encoded > CHUNK_CHARS: raise ValueError("One normalized row exceeds chunk cap")
            if rows and (len(rows) >= CHUNK_ROWS or chars + encoded > CHUNK_CHARS): flush()
            rows.append(row); chars += encoded
        flush()
    manifest = {"format":"patentsview-annualized-prepared","version":1,"year":args.year,
                "release":"grants2025","release_date":"2026-06-10","dictionary_sha256":DICT_SHA,
                "zip_sha256":zip_sha,"csv_member":selected,"csv_sha256":csv_hash.hexdigest(),"declared_csv_bytes":declared_bytes,
                "rows":sum(c["rows"] for c in chunks),"distinct_patents":len(patent_numbers),"chunks":chunks,
                "coverage":"Annualized grants observation CSV for the selected year only; not all history or current ownership."}
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    manifest["manifest_sha256"] = hashlib.sha256(manifest_bytes).hexdigest()
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest

def main():
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("inspect"); p.add_argument("--zip", required=True); p.add_argument("--year", required=True, type=int)
    p = sub.add_parser("prepare"); p.add_argument("--zip", required=True); p.add_argument("--out", required=True); p.add_argument("--year", required=True, type=int); p.add_argument("--dictionary-sha256", required=True); p.add_argument("--expected-zip-sha256")
    args = parser.parse_args()
    if args.year < 1976 or args.year > 2025: raise ValueError("Year outside annualized release coverage")
    result = ({"zip_sha256":sha_file(args.zip),"csv_member":member(args.zip,args.year)[0]} if args.action == "inspect" else prepare(args))
    print(json.dumps(result, separators=(",", ":")))
try:
    main()
except Exception as exc:
    print(json.dumps({"error":str(exc)[:500]}, separators=(",", ":")))
    sys.exit(1)
