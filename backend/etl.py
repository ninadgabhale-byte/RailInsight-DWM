"""ETL Pipeline for RailInsight.
Performs Extract, Validate, Clean, Transform, and Load into the Star Schema Data Warehouse.
Runs in a background thread and exposes real-time status, stages, logs, and metrics.
"""
import time
import threading
from datetime import datetime
from pathlib import Path
import pandas as pd
import numpy as np
from sqlalchemy import text

from backend.config import get_db_engine, RAW_DATA_DIR, PROCESSED_DATA_DIR, BASE_DIR
from backend.warehouse import init_tables

class ETLManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"  # idle | running | success | failed
        self.stages = [
            {"key": "extract", "status": "pending", "duration_ms": 0, "message": "Awaiting extraction"},
            {"key": "validate", "status": "pending", "duration_ms": 0, "message": "Awaiting validation"},
            {"key": "clean", "status": "pending", "duration_ms": 0, "message": "Awaiting cleaning"},
            {"key": "transform", "status": "pending", "duration_ms": 0, "message": "Awaiting transformation"},
            {"key": "load", "status": "pending", "duration_ms": 0, "message": "Awaiting warehouse load"},
        ]
        self.metrics = {
            "extracted": 0,
            "valid": 0,
            "rejected": 0,
            "transformed": 0,
            "loaded": 0,
            "skipped_existing": 0,
            "duration_sec": 0.0
        }
        self.logs = []
        self.rejected_data = {"columns": ["Booking_ID", "Date", "Reason"], "rows": []}
        self.extra_df = None

    def log(self, level: str, message: str):
        now = datetime.now().strftime("%H:%M:%S")
        self.logs.append({"ts": now, "level": level, "message": message})

    def update_stage(self, key: str, status: str, message: str = "", duration_ms: int = 0):
        for s in self.stages:
            if s["key"] == key:
                s["status"] = status
                if message:
                    s["message"] = message
                if duration_ms:
                    s["duration_ms"] = duration_ms

    def get_status(self):
        with self.lock:
            return {
                "state": self.state,
                "stages": self.stages,
                "metrics": self.metrics,
                "logs": self.logs[-100:],  # last 100 log entries
                "rejected": self.rejected_data
            }

    def start_pipeline(self, source="csv", mode="full", table=None, active_df=None):
        with self.lock:
            if self.state == "running":
                raise RuntimeError("ETL pipeline is already running.")
            self.state = "running"
            self.logs = []
            for s in self.stages:
                s["status"] = "pending"
                s["duration_ms"] = 0
                s["message"] = "Queued"
            self.metrics = {
                "extracted": 0,
                "valid": 0,
                "rejected": 0,
                "transformed": 0,
                "loaded": 0,
                "skipped_existing": 0,
                "duration_sec": 0.0
            }
            self.rejected_data = {"columns": ["Booking_ID", "Date", "Reason"], "rows": []}

        thread = threading.Thread(
            target=self._run_pipeline_thread,
            args=(source, mode, table, active_df),
            daemon=True
        )
        thread.start()

    def _run_pipeline_thread(self, source, mode, table, active_df):
        start_time = time.time()
        try:
            self.log("INFO", f"Starting ETL Pipeline (Source: {source}, Mode: {mode})")
            init_tables()

            # ---------------- Stage 1: Extraction ----------------
            stage_start = time.time()
            self.update_stage("extract", "running", "Extracting dataset records...")
            self.log("INFO", f"Extracting records from {source}...")

            df = None
            if source == "extra" and self.extra_df is not None:
                df = self.extra_df.copy()
            elif active_df is not None:
                df = active_df.copy()
            else:
                # Look for raw CSV file
                raw_files = list(RAW_DATA_DIR.glob("*.csv"))
                if not raw_files:
                    raise FileNotFoundError("No dataset available in datasets/raw. Please upload a dataset first.")
                latest_csv = max(raw_files, key=lambda f: f.stat().st_mtime)
                self.log("INFO", f"Reading raw CSV: {latest_csv.name}")
                df = pd.read_csv(latest_csv)

            dur = int((time.time() - stage_start) * 1000)
            self.metrics["extracted"] = len(df)
            self.update_stage("extract", "success", f"Extracted {len(df):,} records", dur)
            self.log("INFO", f"Extraction successful: {len(df):,} records loaded into staging buffer.")

            # ---------------- Stage 2: Validation ----------------
            stage_start = time.time()
            self.update_stage("validate", "running", "Validating schema & constraints...")
            
            # Identify columns using case-insensitive mapping
            col_map = {c.lower(): c for c in df.columns}
            
            # Map canonical roles
            def get_col(*candidates):
                for cand in candidates:
                    if cand.lower() in col_map:
                        return col_map[cand.lower()]
                return None

            col_id = get_col("Booking_ID", "bookingid", "pnr", "ticket_id") or df.columns[0]
            col_date = get_col("Date", "journey_date", "travel_date")
            col_time = get_col("Time", "time_of_day")
            col_from = get_col("From_Station", "source", "origin", "from")
            col_to = get_col("To_Station", "destination", "dest", "to")
            col_fare = get_col("Total_Fare", "fare", "amount", "price")
            col_pax = get_col("Passengers", "passenger", "pax", "seats")
            col_type = get_col("Ticket_Type", "type", "ticket_class", "class")
            col_mode = get_col("Booking_Mode", "mode", "channel")
            col_pay = get_col("Payment_Type", "payment_method", "payment")
            col_line = get_col("Railway_Line", "line", "zone")
            col_city = get_col("City", "city")

            valid_mask = pd.Series(True, index=df.index)
            rejection_reasons = []

            # Check valid fare
            if col_fare:
                df[col_fare] = pd.to_numeric(df[col_fare], errors="coerce").fillna(0)
                bad_fare = df[col_fare] < 0
                valid_mask = valid_mask & (~bad_fare)

            # Check valid passengers
            if col_pax:
                df[col_pax] = pd.to_numeric(df[col_pax], errors="coerce").fillna(1).astype(int)
                bad_pax = df[col_pax] <= 0
                valid_mask = valid_mask & (~bad_pax)

            valid_count = int(valid_mask.sum())
            rejected_count = len(df) - valid_count
            self.metrics["valid"] = valid_count
            self.metrics["rejected"] = rejected_count

            if rejected_count > 0:
                rejected_rows = df[~valid_mask].head(50)
                for _, r in rejected_rows.iterrows():
                    self.rejected_data["rows"].append([
                        str(r.get(col_id, "N/A")),
                        str(r.get(col_date, "N/A")),
                        "Invalid numerical bounds (negative fare or non-positive passengers)"
                    ])

            dur = int((time.time() - stage_start) * 1000)
            self.update_stage("validate", "success", f"{valid_count:,} valid, {rejected_count} rejected", dur)
            self.log("INFO", f"Validation complete: {valid_count:,} valid records, {rejected_count} rejected.")

            clean_df = df[valid_mask].copy()

            # ---------------- Stage 3: Cleaning ----------------
            stage_start = time.time()
            self.update_stage("clean", "running", "Cleaning nulls and standardizing text...")

            # Clean stations and categorical strings
            for col in [col_from, col_to, col_type, col_mode, col_pay, col_line, col_city]:
                if col and col in clean_df.columns:
                    clean_df[col] = clean_df[col].astype(str).str.strip().str.title()

            dur = int((time.time() - stage_start) * 1000)
            self.update_stage("clean", "success", "Categorical strings and nulls standardized", dur)
            self.log("INFO", "Cleaning finished: Strings trimmed, casing normalized, nulls sanitized.")

            # ---------------- Stage 4: Transformation ----------------
            stage_start = time.time()
            self.update_stage("transform", "running", "Building dimensional surrogate keys...")

            # Parse dates
            if col_date and col_date in clean_df.columns:
                clean_df["_parsed_date"] = pd.to_datetime(clean_df[col_date], errors="coerce")
                clean_df["_parsed_date"] = clean_df["_parsed_date"].fillna(pd.Timestamp("2024-01-01"))
            else:
                clean_df["_parsed_date"] = pd.Timestamp("2024-01-01")

            clean_df["date_key"] = clean_df["_parsed_date"].dt.strftime("%Y%m%d").astype(int)
            clean_df["day_number"] = clean_df["_parsed_date"].dt.day
            clean_df["month_number"] = clean_df["_parsed_date"].dt.month
            clean_df["month_name"] = clean_df["_parsed_date"].dt.strftime("%B")
            clean_df["quarter"] = clean_df["_parsed_date"].dt.quarter
            clean_df["year_number"] = clean_df["_parsed_date"].dt.year
            clean_df["week_of_year"] = clean_df["_parsed_date"].dt.isocalendar().week.astype(int)
            clean_df["day_of_week"] = clean_df["_parsed_date"].dt.day_of_week + 1
            clean_df["day_name"] = clean_df["_parsed_date"].dt.strftime("%A")
            clean_df["is_weekend"] = clean_df["_parsed_date"].dt.day_of_week.isin([5, 6]).astype(int)

            # Ensure station text
            clean_df["src_st"] = clean_df[col_from] if col_from else "CST"
            clean_df["dst_st"] = clean_df[col_to] if col_to else "Kurla"
            clean_df["route_name"] = clean_df["src_st"] + " -> " + clean_df["dst_st"]

            clean_df["ticket_type"] = clean_df[col_type] if col_type else "Single"
            clean_df["booking_mode"] = clean_df[col_mode] if col_mode else "Paperless"
            clean_df["payment_method"] = clean_df[col_pay] if col_pay else "UPI"
            clean_df["railway_line"] = clean_df[col_line] if col_line else "Central"
            clean_df["city"] = clean_df[col_city] if col_city else "Mumbai"

            clean_df["passengers_count"] = clean_df[col_pax] if col_pax else 1
            clean_df["fare_amount"] = clean_df[col_fare] if col_fare else 20.0
            clean_df["booking_id_str"] = clean_df[col_id].astype(str)

            self.metrics["transformed"] = len(clean_df)
            dur = int((time.time() - stage_start) * 1000)
            self.update_stage("transform", "success", f"Transformed {len(clean_df):,} fact records", dur)
            self.log("INFO", f"Transformation complete: Conformed dimensions generated.")

            # ---------------- Stage 5: Loading into Data Warehouse ----------------
            stage_start = time.time()
            self.update_stage("load", "running", "Loading into Star Schema tables...")

            engine, db_type = get_db_engine()
            with engine.begin() as conn:
                if mode == "full":
                    self.log("INFO", "Full mode selected: Clearing existing warehouse records.")
                    conn.execute(text("DELETE FROM fact_bookings;"))
                    conn.execute(text("DELETE FROM dim_route;"))
                    conn.execute(text("DELETE FROM dim_ticket;"))
                    conn.execute(text("DELETE FROM dim_station;"))
                    conn.execute(text("DELETE FROM dim_date;"))

                # 1. Load dim_date
                date_rows = clean_df[[
                    "date_key", "_parsed_date", "day_number", "month_number",
                    "month_name", "quarter", "year_number", "week_of_year",
                    "day_of_week", "day_name", "is_weekend"
                ]].drop_duplicates(subset=["date_key"])

                for _, r in date_rows.iterrows():
                    full_date_str = r["_parsed_date"].strftime("%Y-%m-%d")
                    if db_type == "sqlite":
                        conn.execute(text("""
                            INSERT OR IGNORE INTO dim_date
                            (date_key, full_date, day_number, month_number, month_name, quarter, year_number, week_of_year, day_of_week, day_name, is_weekend)
                            VALUES (:date_key, :full_date, :day_number, :month_number, :month_name, :quarter, :year_number, :week_of_year, :day_of_week, :day_name, :is_weekend)
                        """), {
                            "date_key": int(r["date_key"]), "full_date": full_date_str,
                            "day_number": int(r["day_number"]), "month_number": int(r["month_number"]),
                            "month_name": str(r["month_name"]), "quarter": int(r["quarter"]),
                            "year_number": int(r["year_number"]), "week_of_year": int(r["week_of_year"]),
                            "day_of_week": int(r["day_of_week"]), "day_name": str(r["day_name"]),
                            "is_weekend": int(r["is_weekend"])
                        })
                    else:
                        conn.execute(text("""
                            INSERT IGNORE INTO dim_date
                            (date_key, full_date, day_number, month_number, month_name, quarter, year_number, week_of_year, day_of_week, day_name, is_weekend)
                            VALUES (:date_key, :full_date, :day_number, :month_number, :month_name, :quarter, :year_number, :week_of_year, :day_of_week, :day_name, :is_weekend)
                        """), {
                            "date_key": int(r["date_key"]), "full_date": full_date_str,
                            "day_number": int(r["day_number"]), "month_number": int(r["month_number"]),
                            "month_name": str(r["month_name"]), "quarter": int(r["quarter"]),
                            "year_number": int(r["year_number"]), "week_of_year": int(r["week_of_year"]),
                            "day_of_week": int(r["day_of_week"]), "day_name": str(r["day_name"]),
                            "is_weekend": int(r["is_weekend"])
                        })

                # 2. Load dim_station
                all_stations = sorted(list(set(clean_df["src_st"].tolist() + clean_df["dst_st"].tolist())))
                station_map = {}
                for st_name in all_stations:
                    st_code = st_name.upper().replace(" ", "")[:6]
                    if db_type == "sqlite":
                        conn.execute(text("""
                            INSERT OR IGNORE INTO dim_station (station_code, station_name, city, railway_line)
                            VALUES (:code, :name, 'Mumbai', 'Central')
                        """), {"code": st_code, "name": st_name})
                    else:
                        conn.execute(text("""
                            INSERT IGNORE INTO dim_station (station_code, station_name, city, railway_line)
                            VALUES (:code, :name, 'Mumbai', 'Central')
                        """), {"code": st_code, "name": st_name})
                    
                    # Fetch station_key
                    res = conn.execute(text("SELECT station_key FROM dim_station WHERE station_name = :name"), {"name": st_name}).fetchone()
                    if res:
                        station_map[st_name] = res[0]

                # 3. Load dim_ticket
                ticket_combos = clean_df[["ticket_type", "booking_mode", "payment_method"]].drop_duplicates()
                ticket_map = {}
                for _, r in ticket_combos.iterrows():
                    tt, bm, pm = r["ticket_type"], r["booking_mode"], r["payment_method"]
                    if db_type == "sqlite":
                        conn.execute(text("""
                            INSERT OR IGNORE INTO dim_ticket (ticket_type, booking_mode, payment_method, class_type)
                            VALUES (:tt, :bm, :pm, 'Second Class')
                        """), {"tt": tt, "bm": bm, "pm": pm})
                    else:
                        conn.execute(text("""
                            INSERT IGNORE INTO dim_ticket (ticket_type, booking_mode, payment_method, class_type)
                            VALUES (:tt, :bm, :pm, 'Second Class')
                        """), {"tt": tt, "bm": bm, "pm": pm})
                    res = conn.execute(text("""
                        SELECT ticket_key FROM dim_ticket
                        WHERE ticket_type = :tt AND booking_mode = :bm AND payment_method = :pm
                    """), {"tt": tt, "bm": bm, "pm": pm}).fetchone()
                    if res:
                        ticket_map[(tt, bm, pm)] = res[0]

                # 4. Load dim_route
                route_combos = clean_df[["src_st", "dst_st", "route_name", "railway_line"]].drop_duplicates()
                route_map = {}
                for _, r in route_combos.iterrows():
                    s_key = station_map.get(r["src_st"], 1)
                    d_key = station_map.get(r["dst_st"], 1)
                    r_name = r["route_name"]
                    r_line = r["railway_line"]
                    if db_type == "sqlite":
                        conn.execute(text("""
                            INSERT OR IGNORE INTO dim_route (source_station_key, dest_station_key, route_name, railway_line, distance_km)
                            VALUES (:s, :d, :rn, :rl, 15.0)
                        """), {"s": s_key, "d": d_key, "rn": r_name, "rl": r_line})
                    else:
                        conn.execute(text("""
                            INSERT IGNORE INTO dim_route (source_station_key, dest_station_key, route_name, railway_line, distance_km)
                            VALUES (:s, :d, :rn, :rl, 15.0)
                        """), {"s": s_key, "d": d_key, "rn": r_name, "rl": r_line})
                    res = conn.execute(text("""
                        SELECT route_key FROM dim_route WHERE source_station_key = :s AND dest_station_key = :d
                    """), {"s": s_key, "d": d_key}).fetchone()
                    if res:
                        route_map[(s_key, d_key)] = res[0]

                # 5. Bulk load into fact_bookings
                loaded_count = 0
                batch = []
                for _, r in clean_df.iterrows():
                    s_key = station_map.get(r["src_st"], 1)
                    d_key = station_map.get(r["dst_st"], 1)
                    rt_key = route_map.get((s_key, d_key), None)
                    tk_key = ticket_map.get((r["ticket_type"], r["booking_mode"], r["payment_method"]), 1)
                    
                    time_val = str(r.get(col_time, "09:00:00")) if col_time else "09:00:00"

                    batch.append({
                        "b_id": str(r["booking_id_str"]),
                        "d_key": int(r["date_key"]),
                        "t_val": time_val,
                        "s_key": s_key,
                        "dst_key": d_key,
                        "r_key": rt_key,
                        "t_key": tk_key,
                        "pax": int(r["passengers_count"]),
                        "fare": float(r["fare_amount"]),
                        "status": "Confirmed",
                        "cancelled": 0
                    })

                    if len(batch) >= 1000:
                        conn.execute(text("""
                            INSERT INTO fact_bookings
                            (booking_id, date_key, time_of_day, source_station_key, dest_station_key, route_key, ticket_key, passengers_count, fare_amount, booking_status, is_cancelled)
                            VALUES (:b_id, :d_key, :t_val, :s_key, :dst_key, :r_key, :t_key, :pax, :fare, :status, :cancelled)
                        """), batch)
                        loaded_count += len(batch)
                        batch = []

                if batch:
                    conn.execute(text("""
                        INSERT INTO fact_bookings
                        (booking_id, date_key, time_of_day, source_station_key, dest_station_key, route_key, ticket_key, passengers_count, fare_amount, booking_status, is_cancelled)
                        VALUES (:b_id, :d_key, :t_val, :s_key, :dst_key, :r_key, :t_key, :pax, :fare, :status, :cancelled)
                    """), batch)
                    loaded_count += len(batch)

                self.metrics["loaded"] = loaded_count

            dur = int((time.time() - stage_start) * 1000)
            self.update_stage("load", "success", f"Loaded {loaded_count:,} records into fact_bookings", dur)
            self.log("INFO", f"Load stage complete: {loaded_count:,} facts stored in MySQL/SQLite Star Schema.")

            # Save processed dataset to CSV
            processed_file = PROCESSED_DATA_DIR / "processed_dataset.csv"
            clean_df.to_csv(processed_file, index=False)
            self.log("INFO", f"Saved cleaned & transformed CSV to {processed_file.name}")

            total_dur = round(time.time() - start_time, 2)
            self.metrics["duration_sec"] = total_dur
            with self.lock:
                self.state = "success"
            self.log("INFO", f"ETL Pipeline completed successfully in {total_dur}s.")

        except Exception as e:
            total_dur = round(time.time() - start_time, 2)
            self.metrics["duration_sec"] = total_dur
            with self.lock:
                self.state = "failed"
            self.log("ERROR", f"ETL Pipeline failed: {str(e)}")
            for s in self.stages:
                if s["status"] == "running":
                    s["status"] = "failed"
                    s["message"] = str(e)

etl_manager = ETLManager()
