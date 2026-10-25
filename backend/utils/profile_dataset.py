"""Phase 1 - dataset profiler.
Reads a railway CSV WITHOUT assuming column names and writes:
  docs/data_dictionary.csv, docs/data_dictionary.md, docs/profile.json
Usage (from project root):  python backend/utils/profile_dataset.py datasets/raw/Uts_Data.csv
"""
import json
import sys
from pathlib import Path

import pandas as pd

# Keyword hints used ONLY to suggest a railway role; the user confirms in the mapping UI.
ROLE_HINTS = {
    "booking_id": ["booking_id", "bookingid", "pnr", "ticket_id"],
    "journey_date": ["date", "journey_date", "travel_date"],
    "time": ["time"],
    "source_station": ["from_station", "source", "origin", "from"],
    "destination_station": ["to_station", "destination", "dest", "to"],
    "fare": ["fare", "amount", "price", "revenue"],
    "passengers": ["passenger", "pax", "seats"],
    "ticket_type": ["ticket_type", "class", "ticket_class"],
    "booking_mode": ["booking_mode", "mode", "channel"],
    "payment_method": ["payment"],
    "railway_line": ["line", "zone", "route_name"],
    "city": ["city"],
    "month": ["month"],
    "week": ["week"],
}


def suggest_role(col: str):
    c = col.lower()
    tokens = set(c.replace("-", "_").split("_"))
    for role, hints in ROLE_HINTS.items():
        # short hints ("to", "from") must match a whole word, so "total_fare" is not read as "to"
        if any(c == h or h in tokens or (len(h) > 4 and h in c) for h in hints):
            return role
    return None


def detect_kind(s: pd.Series, name: str) -> str:
    if pd.api.types.is_numeric_dtype(s):
        return "numerical"
    sample = s.dropna().astype(str).head(2000)
    if not sample.empty:
        for fmt in (None,):
            parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
            if parsed.notna().mean() > 0.95 and sample.str.contains(r"[/-]").mean() > 0.9:
                return "date"
        t = pd.to_datetime(sample, errors="coerce", format="%H:%M:%S")
        if t.notna().mean() > 0.95:
            return "time"
    return "categorical"


def profile(path: str) -> dict:
    df = pd.read_csv(path)
    rows = []
    for col in df.columns:
        s = df[col]
        kind = detect_kind(s, col)
        info = {
            "column": col,
            "pandas_dtype": str(s.dtype),
            "detected_kind": kind,
            "suggested_role": suggest_role(col),
            "missing": int(s.isna().sum()),
            "unique": int(s.nunique()),
            "unique_ratio": round(s.nunique() / len(df), 5),
        }
        if kind == "numerical":
            info.update(min=float(s.min()), max=float(s.max()), mean=round(float(s.mean()), 3))
        elif kind == "categorical" and s.nunique() <= 20:
            info["values"] = {str(k): int(v) for k, v in s.value_counts().items()}
        rows.append(info)

    key_col = next((r["column"] for r in rows if r["suggested_role"] == "booking_id"), None)
    notes = []
    if key_col and df[key_col].nunique() < len(df):
        notes.append(f"'{key_col}' is NOT unique ({df[key_col].nunique()} unique in {len(df)} rows): "
                     "treat as a degenerate attribute, not a primary key.")
    notes.append(f"Exact duplicate rows: {int(df.duplicated().sum())}")
    return {"file": Path(path).name, "rows": len(df), "columns": len(df.columns),
            "columns_info": rows, "notes": notes}


def write_outputs(p: dict, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    flat = pd.DataFrame([{k: v for k, v in r.items() if k != "values"} for r in p["columns_info"]])
    flat.to_csv(out / "data_dictionary.csv", index=False)
    (out / "profile.json").write_text(json.dumps(p, indent=2), encoding="utf-8")
    lines = [f"# Data Dictionary - {p['file']}", "",
             f"Rows: **{p['rows']:,}** | Columns: **{p['columns']}**", "",
             "| Column | Type | Kind | Suggested role | Missing | Unique | Observed values / range |",
             "|---|---|---|---|---|---|---|"]
    for r in p["columns_info"]:
        if "values" in r:
            detail = ", ".join(r["values"])[:90]
        elif "min" in r:
            detail = f"{r['min']:g} to {r['max']:g} (mean {r['mean']:g})"
        else:
            detail = ""
        lines.append(f"| {r['column']} | {r['pandas_dtype']} | {r['detected_kind']} | "
                     f"{r['suggested_role'] or '-'} | {r['missing']} | {r['unique']:,} | {detail} |")
    lines += ["", "## Data-quality notes", ""] + [f"- {n}" for n in p["notes"]]
    (out / "data_dictionary.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python backend/utils/profile_dataset.py <path-to-csv>")
    result = profile(sys.argv[1])
    write_outputs(result, Path(__file__).resolve().parents[2] / "docs")
    print(f"Profiled {result['rows']:,} rows x {result['columns']} columns")
    for n in result["notes"]:
        print(" -", n)
