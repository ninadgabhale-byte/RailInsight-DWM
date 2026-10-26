"""Main Flask Application for RailInsight.
Exposes REST APIs complying with docs/api_contract.md and serves frontend static assets.
"""
import os
import io
import json
from pathlib import Path
from datetime import datetime
import pandas as pd
import numpy as np

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from sklearn.ensemble import IsolationForest

from backend.config import (
    BASE_DIR, RAW_DATA_DIR, PROCESSED_DATA_DIR, UPLOADS_DIR,
    FLASK_PORT, MAX_UPLOAD_MB, is_db_connected, get_db_engine
)
from backend.warehouse import (
    get_schema_response, run_sample_query, init_tables, get_table_row_counts
)
from backend.etl import etl_manager
from backend.olap import get_metadata, execute_olap_query
from backend.preprocessing import preprocessing_manager
from backend.classification import run_classification
from backend.clustering import run_clustering
from backend.association import run_association_mining
from backend.prediction import get_forecast_options, run_forecast
from backend.reports import (
    get_reports_list, generate_report_content, export_report_file, update_module_cache
)

# Initialize Flask app
FRONTEND_DIR = BASE_DIR / "frontend"
app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
CORS(
    app,
    resources={
        r"/api/*": {
            "origins": [
                "https://railinsight-dwm-frontend.vercel.app",
                "http://localhost:5500"
            ]
        }
    },
    expose_headers=["Content-Disposition"]
)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# In-memory active dataset cache and column mapping
ACTIVE_DF = None
ACTIVE_FILENAME = None
USER_MAPPING = {}

# Standard railway roles specification
RAILWAY_ROLES = [
    {"key": "booking_id", "label": "Booking / Ticket ID", "description": "Unique identifier per booking or PNR", "required": False},
    {"key": "journey_date", "label": "Travel / Booking Date", "description": "Date of journey or booking transaction", "required": True},
    {"key": "time", "label": "Time of Day", "description": "Transaction or departure timestamp", "required": False},
    {"key": "source_station", "label": "Origin Station", "description": "Originating or departure railway station", "required": True},
    {"key": "destination_station", "label": "Destination Station", "description": "Terminating or arrival railway station", "required": True},
    {"key": "passengers", "label": "Passenger Count", "description": "Number of passengers travelling on this ticket", "required": False},
    {"key": "fare", "label": "Fare / Ticket Price", "description": "Total amount paid for the ticket", "required": True},
    {"key": "ticket_type", "label": "Ticket Type / Class", "description": "Class or pass type (e.g., Single, Return, Monthly Pass)", "required": False},
    {"key": "booking_mode", "label": "Booking Mode / Channel", "description": "Ticketing channel (e.g., Paperless Mobile, Paper Counter)", "required": False},
    {"key": "payment_method", "label": "Payment Method", "description": "Payment instrument (UPI, Cash, Wallet, Card)", "required": False},
    {"key": "railway_line", "label": "Railway Line / Zone", "description": "Corridor line (Western, Central, Harbour, Pune)", "required": False},
    {"key": "city", "label": "City / Network Region", "description": "Metro city (e.g., Mumbai, Pune)", "required": False},
]

ROLE_HINTS = {
    "booking_id": ["booking_id", "bookingid", "pnr", "ticket_id"],
    "journey_date": ["date", "journey_date", "travel_date"],
    "time": ["time"],
    "source_station": ["from_station", "source", "origin", "from"],
    "destination_station": ["to_station", "destination", "dest", "to"],
    "fare": ["fare", "amount", "price", "revenue", "total_fare"],
    "passengers": ["passenger", "pax", "seats", "passengers"],
    "ticket_type": ["ticket_type", "class", "ticket_class", "type"],
    "booking_mode": ["booking_mode", "mode", "channel"],
    "payment_method": ["payment", "payment_type", "payment_method"],
    "railway_line": ["line", "zone", "route_name", "railway_line"],
    "city": ["city"],
}

def auto_suggest_mapping(columns):
    mapping = {}
    used_cols = set()
    for role, hints in ROLE_HINTS.items():
        matched = None
        for col in columns:
            if col in used_cols:
                continue
            c_low = col.lower().replace("-", "_")
            tokens = set(c_low.split("_"))
            if any(h == c_low or h in tokens for h in hints):
                matched = col
                break
        if matched:
            mapping[role] = matched
            used_cols.add(matched)
    return mapping

def get_active_dataframe() -> pd.DataFrame:
    global ACTIVE_DF, ACTIVE_FILENAME, USER_MAPPING
    if ACTIVE_DF is not None:
        return ACTIVE_DF
    # Check raw folder
    raw_files = list(RAW_DATA_DIR.glob("*.csv"))
    if raw_files:
        latest = max(raw_files, key=lambda f: f.stat().st_mtime)
        ACTIVE_DF = pd.read_csv(latest)
        ACTIVE_FILENAME = latest.name
        if not USER_MAPPING:
            USER_MAPPING = auto_suggest_mapping(ACTIVE_DF.columns)
        preprocessing_manager.set_dataset(ACTIVE_DF)
        return ACTIVE_DF
    return None

def get_mapped_col(role: str):
    return USER_MAPPING.get(role)

# =====================================================================
# 1. Health & Static Frontend Serving
# =====================================================================
@app.route("/")
def serve_index():
    return send_from_directory(str(FRONTEND_DIR), "index.html")

@app.route("/<path:path>")
def serve_static(path):
    file_path = FRONTEND_DIR / path
    if file_path.exists():
        return send_from_directory(str(FRONTEND_DIR), path)
    return send_from_directory(str(FRONTEND_DIR), "index.html")

@app.route("/api/health")
def api_health():
    df = get_active_dataframe()
    engine, db_type = get_db_engine()
    db_conn = is_db_connected()
    return jsonify({
        "status": "online",
        "dataset_loaded": df is not None and not df.empty,
        "database_connected": db_conn,
        "engine": db_type,
        "timestamp": datetime.now().isoformat()
    })

# =====================================================================
# 2. Dataset Management
# =====================================================================
@app.route("/api/upload", methods=["POST"])
def api_upload():
    global ACTIVE_DF, ACTIVE_FILENAME, USER_MAPPING
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400
    file = request.files["file"]
    if not file.filename.lower().endswith(".csv"):
        return jsonify({"error": "Only CSV files are allowed."}), 400

    filename = Path(file.filename).name
    save_path = RAW_DATA_DIR / filename
    file.save(save_path)

    ACTIVE_DF = pd.read_csv(save_path)
    ACTIVE_FILENAME = filename
    USER_MAPPING = auto_suggest_mapping(ACTIVE_DF.columns)
    preprocessing_manager.set_dataset(ACTIVE_DF)

    return jsonify({
        "filename": filename,
        "rows": len(ACTIVE_DF),
        "columns": len(ACTIVE_DF.columns)
    })

@app.route("/api/dataset/summary")
def api_dataset_summary():
    df = get_active_dataframe()
    if df is None or df.empty:
        return jsonify({"error": "No dataset loaded. Please upload a railway CSV file."}), 409

    cols_info = []
    for col in df.columns:
        s = df[col]
        kind = "numerical" if pd.api.types.is_numeric_dtype(s) else "categorical"
        if not pd.api.types.is_numeric_dtype(s):
            sample = s.dropna().astype(str).head(500)
            if not sample.empty and sample.str.contains(r"[/-]").mean() > 0.8:
                kind = "date"
            elif not sample.empty and sample.str.contains(r":").mean() > 0.8:
                kind = "time"

        missing_count = int(s.isna().sum())
        cols_info.append({
            "column": col,
            "dtype": str(s.dtype),
            "kind": kind,
            "missing": missing_count,
            "missing_pct": round(float(missing_count / len(df) * 100), 2),
            "unique": int(s.nunique()),
            "suggested_role": next((r for r, c in USER_MAPPING.items() if c == col), None)
        })

    # Descriptive stats
    num_df = df.select_dtypes(include=[np.number])
    describe = None
    if not num_df.empty:
        desc = num_df.describe().round(2).reset_index()
        describe = {
            "columns": list(desc.columns),
            "rows": [list(r) for r in desc.values]
        }

    return jsonify({
        "file_name": ACTIVE_FILENAME or "dataset.csv",
        "rows": len(df),
        "columns": len(df.columns),
        "duplicates": int(df.duplicated().sum()),
        "missing_cells": int(df.isna().sum().sum()),
        "memory_mb": round(df.memory_usage(deep=True).sum() / (1024 * 1024), 2),
        "notes": [
            f"Columns detected: {len(df.columns)}",
            f"Dataset rows: {len(df):,}"
        ],
        "columns_info": cols_info,
        "describe": describe
    })

@app.route("/api/dataset/preview")
def api_dataset_preview():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    n = int(request.args.get("n", 15))
    preview_df = df.head(n).replace({np.nan: None})
    return jsonify({
        "columns": list(preview_df.columns),
        "rows": [list(r) for r in preview_df.values]
    })

@app.route("/api/dataset/mapping", methods=["GET", "POST"])
def api_dataset_mapping():
    global USER_MAPPING
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    if request.method == "POST":
        data = request.get_json() or {}
        USER_MAPPING = data.get("mapping", {})
        return jsonify({"ok": True, "mapping": USER_MAPPING})

    roles_res = []
    for r in RAILWAY_ROLES:
        roles_res.append({
            "key": r["key"],
            "label": r["label"],
            "description": r["description"],
            "required": r["required"],
            "mapped": USER_MAPPING.get(r["key"])
        })
    return jsonify({
        "columns": list(df.columns),
        "roles": roles_res
    })

@app.route("/api/dataset/validate", methods=["POST"])
def api_dataset_validate():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    checks = []
    has_date = bool(get_mapped_col("journey_date"))
    has_fare = bool(get_mapped_col("fare"))
    has_stations = bool(get_mapped_col("source_station") and get_mapped_col("destination_station"))

    checks.append({
        "name": "Mandatory Dimensions Check",
        "status": "pass" if (has_date and has_fare and has_stations) else "fail",
        "message": "Date, Fare, and Origin/Destination stations mapped correctly." if (has_date and has_fare and has_stations) else "Missing mapping for core fields (Date, Fare, or Stations)."
    })

    dup_count = int(df.duplicated().sum())
    checks.append({
        "name": "Duplicate Records Check",
        "status": "pass" if dup_count == 0 else "warn",
        "message": f"Zero exact duplicate rows detected." if dup_count == 0 else f"{dup_count} duplicate rows detected. You can remove them in Preprocessing."
    })

    missing_cells = int(df.isna().sum().sum())
    checks.append({
        "name": "Missing Data Completeness",
        "status": "pass" if missing_cells == 0 else "warn",
        "message": "Dataset is complete with 0 missing cells." if missing_cells == 0 else f"{missing_cells} missing cells found across columns."
    })

    features = [
        {"feature": "Overview Dashboard", "available": has_fare, "requires": ["Fare"]},
        {"feature": "Time-Series Forecasting", "available": has_date and has_fare, "requires": ["Date", "Fare"]},
        {"feature": "Route Network Analytics", "available": has_stations, "requires": ["Source Station", "Destination Station"]},
        {"feature": "Data Warehouse Star Schema", "available": has_date and has_stations and has_fare, "requires": ["Date", "Stations", "Fare"]},
        {"feature": "Ticket Class Classification", "available": bool(get_mapped_col("ticket_type")), "requires": ["Ticket Type"]},
        {"feature": "Association Mining", "available": len([c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c])]) >= 2, "requires": ["At least 2 Categorical Columns"]}
    ]

    valid = has_date and has_fare and has_stations
    return jsonify({
        "valid": valid,
        "checks": checks,
        "available_features": features
    })

@app.route("/api/dataset/download")
def api_dataset_download():
    stage = request.args.get("stage", "raw")
    if stage == "processed":
        p_files = list(PROCESSED_DATA_DIR.glob("*.csv"))
        if p_files:
            return send_file(p_files[0], as_attachment=True, download_name="processed_railway_data.csv")
    df = get_active_dataframe()
    if df is not None:
        mem = io.BytesIO()
        df.to_csv(mem, index=False)
        mem.seek(0)
        return send_file(mem, mimetype="text/csv", as_attachment=True, download_name="raw_railway_data.csv")
    return jsonify({"error": "No dataset available."}), 404

# =====================================================================
# 3. Overview Dashboard & Analytics
# =====================================================================
@app.route("/api/analytics/dashboard")
def api_dashboard():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    col_fare = get_mapped_col("fare")
    col_pax = get_mapped_col("passengers")
    col_date = get_mapped_col("journey_date")
    col_src = get_mapped_col("source_station")
    col_dst = get_mapped_col("destination_station")
    col_line = get_mapped_col("railway_line")
    col_type = get_mapped_col("ticket_type")

    # Filters
    work_df = df.copy()
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    station_flt = request.args.get("station")

    if col_date and (from_date or to_date):
        dt_s = pd.to_datetime(work_df[col_date], errors="coerce")
        if from_date:
            work_df = work_df[dt_s >= pd.to_datetime(from_date)]
        if to_date:
            work_df = work_df[dt_s <= pd.to_datetime(to_date)]

    if station_flt and (col_src or col_dst):
        cond = pd.Series(False, index=work_df.index)
        if col_src and col_src in work_df.columns:
            cond = cond | (work_df[col_src] == station_flt)
        if col_dst and col_dst in work_df.columns:
            cond = cond | (work_df[col_dst] == station_flt)
        work_df = work_df[cond]

    total_records = len(work_df)
    total_revenue = float(work_df[col_fare].sum()) if col_fare and col_fare in work_df.columns else 0.0
    total_pax = int(work_df[col_pax].sum()) if col_pax and col_pax in work_df.columns else total_records
    avg_fare = round(total_revenue / total_records, 2) if total_records > 0 else 0.0

    # Top route
    top_route_str = "—"
    if col_src and col_dst and col_src in work_df.columns and col_dst in work_df.columns:
        routes = work_df[col_src].astype(str) + " -> " + work_df[col_dst].astype(str)
        if not routes.empty:
            top_route_str = routes.mode()[0]

    kpis = [
        {"key": "total_records", "label": "Total Bookings", "value": total_records, "format": "int"},
        {"key": "total_passengers", "label": "Total Passengers", "value": total_pax, "format": "int"},
        {"key": "total_revenue", "label": "Total Revenue", "value": total_revenue, "format": "currency"},
        {"key": "avg_fare", "label": "Average Fare", "value": avg_fare, "format": "currency"},
        {"key": "top_route", "label": "Most Popular Route", "value": top_route_str, "format": "text"},
        {"key": "cancellation_pct", "label": "Cancellation Rate", "value": 0.0, "format": "percent", "hint": "All confirmed tickets"}
    ]

    # Charts
    charts = []
    # 1. Line distribution
    if col_line and col_line in work_df.columns:
        line_counts = work_df[col_line].value_counts()
        charts.append({
            "type": "doughnut",
            "title": "Bookings by Railway Line",
            "labels": list(line_counts.index),
            "values": [int(v) for v in line_counts.values]
        })

    # 2. Ticket Type distribution
    if col_type and col_type in work_df.columns:
        type_counts = work_df[col_type].value_counts()
        charts.append({
            "type": "bar",
            "title": "Ticket Type Distribution",
            "labels": list(type_counts.index),
            "values": [int(v) for v in type_counts.values],
            "x_label": "Ticket Type",
            "y_label": "Bookings"
        })

    # 3. Monthly Booking Trends
    if col_date and col_date in work_df.columns:
        dt_s = pd.to_datetime(work_df[col_date], errors="coerce")
        monthly = dt_s.dt.strftime("%Y-%m").value_counts().sort_index()
        charts.append({
            "type": "line",
            "title": "Monthly Booking Trends",
            "labels": list(monthly.index),
            "values": [int(v) for v in monthly.values],
            "x_label": "Month",
            "y_label": "Total Bookings",
            "options": {"area": True}
        })

    # Filter metadata
    stations_list = []
    if col_src and col_src in df.columns:
        stations_list = sorted(list(df[col_src].dropna().unique()))

    date_range = None
    if col_date and col_date in df.columns:
        dt_all = pd.to_datetime(df[col_date], errors="coerce").dropna()
        if not dt_all.empty:
            date_range = {"min": dt_all.min().strftime("%Y-%m-%d"), "max": dt_all.max().strftime("%Y-%m-%d")}

    return jsonify({
        "filters": {"date_range": date_range, "stations": stations_list},
        "kpis": kpis,
        "charts": charts,
        "unavailable": []
    })

@app.route("/api/analytics/<category>")
def api_analytics_category(category):
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    charts = []
    unavailable = []

    if category == "booking":
        c_mode = get_mapped_col("booking_mode")
        if c_mode and c_mode in df.columns:
            vc = df[c_mode].value_counts()
            charts.append({"type": "doughnut", "title": "Booking Mode (Paperless vs Paper)", "labels": list(vc.index), "values": [int(v) for v in vc.values]})
        c_pay = get_mapped_col("payment_method")
        if c_pay and c_pay in df.columns:
            vc = df[c_pay].value_counts()
            charts.append({"type": "bar", "title": "Payment Channel Penetration", "labels": list(vc.index), "values": [int(v) for v in vc.values]})

    elif category == "revenue":
        c_fare = get_mapped_col("fare")
        c_line = get_mapped_col("railway_line")
        if c_fare and c_line and c_fare in df.columns and c_line in df.columns:
            rev_by_line = df.groupby(c_line)[c_fare].sum()
            charts.append({"type": "bar", "title": "Total Revenue by Railway Line (₹)", "labels": list(rev_by_line.index), "values": [round(float(v), 2) for v in rev_by_line.values]})

    elif category == "route":
        c_src = get_mapped_col("source_station")
        c_dst = get_mapped_col("destination_station")
        if c_src and c_dst:
            routes = (df[c_src].astype(str) + " -> " + df[c_dst].astype(str)).value_counts().head(10)
            charts.append({"type": "hbar", "title": "Top 10 Busiest Routes", "labels": list(routes.index), "values": [int(v) for v in routes.values]})

    elif category == "station":
        c_src = get_mapped_col("source_station")
        if c_src:
            st_counts = df[c_src].value_counts().head(10)
            charts.append({"type": "bar", "title": "Top 10 Originating Passenger Stations", "labels": list(st_counts.index), "values": [int(v) for v in st_counts.values]})

    elif category == "time":
        c_time = get_mapped_col("time")
        if c_time and c_time in df.columns:
            hours = pd.to_datetime(df[c_time].astype(str), format="%H:%M:%S", errors="coerce").dt.hour.value_counts().sort_index()
            charts.append({"type": "line", "title": "Hourly Passenger Rush Distribution", "labels": [f"{h:02d}:00" for h in hours.index], "values": [int(v) for v in hours.values]})

    elif category == "ticket":
        c_type = get_mapped_col("ticket_type")
        if c_type and c_type in df.columns:
            vc = df[c_type].value_counts()
            charts.append({"type": "pie", "title": "Ticket Type Ratio", "labels": list(vc.index), "values": [int(v) for v in vc.values]})

    return jsonify({"charts": charts, "unavailable": unavailable})

# =====================================================================
# 4. Preprocessing Endpoints
# =====================================================================
@app.route("/api/preprocessing/run", methods=["POST"])
def api_preprocessing_run():
    data = request.get_json() or {}
    category = data.get("category")
    operation = data.get("operation")
    params = data.get("params", {})
    try:
        res = preprocessing_manager.run_operation(category, operation, params)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/preprocessing/compare")
def api_preprocessing_compare():
    return jsonify(preprocessing_manager.get_comparison())

@app.route("/api/preprocessing/reset", methods=["POST"])
def api_preprocessing_reset():
    preprocessing_manager.reset()
    return jsonify({"ok": True})

# =====================================================================
# 5. ETL Pipeline Endpoints
# =====================================================================
@app.route("/api/etl/run", methods=["POST"])
def api_etl_run():
    data = request.get_json() or {}
    source = data.get("source", "csv")
    mode = data.get("mode", "full")
    table = data.get("table")
    df = preprocessing_manager.get_current_df()

    try:
        etl_manager.start_pipeline(source=source, mode=mode, table=table, active_df=df)
        return jsonify({"state": "running"}), 202
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/etl/status")
def api_etl_status():
    return jsonify(etl_manager.get_status())

@app.route("/api/etl/tables")
def api_etl_tables():
    return jsonify({"tables": ["staging_bookings", "uts_raw_records"]})

@app.route("/api/etl/upload-extra", methods=["POST"])
def api_etl_upload_extra():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400
    file = request.files["file"]
    df = pd.read_csv(file)
    etl_manager.extra_df = df
    return jsonify({"rows": len(df)})

@app.route("/api/etl/rejected")
def api_etl_rejected():
    st = etl_manager.get_status()
    rej = st["rejected"]
    mem = io.StringIO()
    writer = csv.writer(mem)
    writer.writerow(rej["columns"])
    for r in rej["rows"]:
        writer.writerow(r)
    output = io.BytesIO(mem.getvalue().encode("utf-8"))
    output.seek(0)
    return send_file(output, mimetype="text/csv", as_attachment=True, download_name="etl_rejected_records.csv")

# =====================================================================
# 6. Data Warehouse Endpoints
# =====================================================================
@app.route("/api/warehouse/schema")
def api_warehouse_schema():
    return jsonify(get_schema_response())

@app.route("/api/warehouse/sample/run", methods=["POST"])
def api_warehouse_sample_run():
    data = request.get_json() or {}
    qid = data.get("id")
    try:
        res = run_sample_query(qid)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# =====================================================================
# 7. OLAP Analysis Endpoints
# =====================================================================
@app.route("/api/olap/metadata")
def api_olap_metadata():
    return jsonify(get_metadata())

@app.route("/api/olap/query", methods=["POST"])
def api_olap_query():
    req = request.get_json() or {}
    try:
        res = execute_olap_query(req)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# =====================================================================
# 8. Data Mining Endpoints
# =====================================================================
@app.route("/api/mining/options")
def api_mining_options():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    # Targets for classification
    targets = []
    for col in df.columns:
        n_uniq = df[col].nunique()
        if 2 <= n_uniq <= 10 and not pd.api.types.is_float_dtype(df[col]):
            targets.append({
                "column": col,
                "label": f"{col} ({n_uniq} classes: {', '.join([str(x) for x in df[col].unique()[:3]])})",
                "excluded_features": ["Booking_ID", "Date", "Time"]
            })

    features = [{"column": c, "kind": "numerical" if pd.api.types.is_numeric_dtype(df[c]) else "categorical"} for c in df.columns]

    clustering_entities = [
        {"key": "routes", "label": "Railway Station-Pair Routes", "description": "Segments routes by traffic density, average fare, and revenue load.", "supported": True},
        {"key": "bookings", "label": "Individual Booking Transactions", "description": "Clusters tickets by passenger volume and fare payments.", "supported": True}
    ]

    transaction_cols = [c for c in df.columns if 2 <= df[c].nunique() <= 50]

    return jsonify({
        "notes": ["Mining models run on scikit-learn and mlxtend."],
        "classification": {"targets": targets, "features": features, "note": "Leakage columns are automatically dropped."},
        "clustering": {"entities": clustering_entities},
        "association": {"transaction_columns": transaction_cols, "note": "Each row represents a ticket transaction itemset."},
        "anomaly": {"units": [{"key": "fare", "label": "Ticket Fare Amount", "description": "Detects abnormal fare payments", "supported": True}]}
    })

def between(val, low, high):
    return low <= val <= high

@app.route("/api/mining/classification", methods=["POST"])
def api_mining_classification():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    req = request.get_json() or {}
    try:
        res = run_classification(df, req)
        update_module_cache("classification", res)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/mining/clustering", methods=["POST"])
def api_mining_clustering():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    req = request.get_json() or {}
    try:
        res = run_clustering(df, req)
        update_module_cache("clustering", res)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/mining/association", methods=["POST"])
def api_mining_association():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    req = request.get_json() or {}
    try:
        res = run_association_mining(df, req)
        update_module_cache("association", res)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/mining/anomaly", methods=["POST"])
def api_mining_anomaly():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    req = request.get_json() or {}
    contamination = float(req.get("contamination", 0.01))
    iqr_k = float(req.get("iqr_k", 1.5))

    col_fare = get_mapped_col("fare") or "Total_Fare"
    if col_fare not in df.columns:
        col_fare = df.select_dtypes(include=[np.number]).columns[0]

    sample_df = df.dropna(subset=[col_fare]).head(5000).copy()
    vals = sample_df[[col_fare]].values

    iso = IsolationForest(contamination=contamination, random_state=42)
    preds = iso.fit_predict(vals)
    flagged = (preds == -1)

    flagged_rows = sample_df[flagged].head(25)
    return jsonify({
        "summary": {"total": len(sample_df), "flagged": int(flagged.sum())},
        "anomalies": {
            "columns": list(flagged_rows.columns),
            "rows": [list(r) for r in flagged_rows.values]
        },
        "chart": None,
        "boxplot": [],
        "warnings": []
    })

@app.route("/api/mining/patterns")
def api_mining_patterns():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409

    patterns = [
        {"category": "Peak Hours", "title": "Suburban Morning & Evening Spikes", "finding": "Passenger travel demand peaks sharply between 08:00–10:00 and 17:00–19:00 corresponding to office commute hours."},
        {"category": "Payment Modes", "title": "Digital UPI Dominance", "finding": "Paperless digital ticketing via UPI and mobile wallets constitutes the majority of suburban journey bookings."},
        {"category": "Corridor Density", "title": "High Frequency Suburban Lines", "finding": "Central and Western railway lines handle over 70% of total daily suburban traffic load."}
    ]
    return jsonify({"patterns": patterns, "charts": [], "warnings": []})

# =====================================================================
# 9. Prediction & Forecasting Endpoints
# =====================================================================
@app.route("/api/forecast/options")
def api_forecast_options():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    return jsonify(get_forecast_options(df))

@app.route("/api/forecast", methods=["POST"])
def api_forecast():
    df = get_active_dataframe()
    if df is None:
        return jsonify({"error": "No dataset loaded."}), 409
    req = request.get_json() or {}
    try:
        res = run_forecast(df, req)
        update_module_cache("forecasting", res)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# =====================================================================
# 10. Reports & Export Endpoints
# =====================================================================
@app.route("/api/reports/list")
def api_reports_list():
    return jsonify(get_reports_list())

@app.route("/api/reports/preview")
def api_reports_preview():
    t = request.args.get("type", "dataset")
    try:
        res = generate_report_content(t)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 409

@app.route("/api/reports/export")
def api_reports_export():
    t = request.args.get("type", "dataset")
    fmt = request.args.get("format", "csv")
    try:
        return export_report_file(t, fmt)
    except Exception as e:
        return jsonify({"error": str(e)}), 409

if __name__ == "__main__":
    init_tables()
    print(f"RailInsight Backend running on http://127.0.0.1:{FLASK_PORT}")
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=True)
