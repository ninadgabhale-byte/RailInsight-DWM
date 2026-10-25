"""Data Warehouse dimensional modeling and Star Schema management.
Implements Star Schema tables, DDL generation, schema inspection, and sample OLAP queries.
"""
from sqlalchemy import text
from backend.config import get_db_engine, BASE_DIR

DDL_FILE = BASE_DIR / "database" / "schema.sql"

STAR_SCHEMA_DEFINITION = {
    "grain": "One row per railway ticket booking transaction.",
    "tables": [
        {
            "name": "fact_bookings",
            "kind": "fact",
            "columns": [
                {"name": "booking_fact_id", "type": "BIGINT", "key": "PK", "references": None},
                {"name": "booking_id", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "date_key", "type": "INT", "key": "FK", "references": "dim_date.date_key"},
                {"name": "time_of_day", "type": "TIME", "key": None, "references": None},
                {"name": "source_station_key", "type": "INT", "key": "FK", "references": "dim_station.station_key"},
                {"name": "dest_station_key", "type": "INT", "key": "FK", "references": "dim_station.station_key"},
                {"name": "route_key", "type": "INT", "key": "FK", "references": "dim_route.route_key"},
                {"name": "ticket_key", "type": "INT", "key": "FK", "references": "dim_ticket.ticket_key"},
                {"name": "train_key", "type": "INT", "key": "FK", "references": "dim_train.train_key"},
                {"name": "passenger_key", "type": "INT", "key": "FK", "references": "dim_passenger.passenger_key"},
                {"name": "passengers_count", "type": "INT", "key": None, "references": None},
                {"name": "fare_amount", "type": "DECIMAL(10,2)", "key": None, "references": None},
                {"name": "booking_status", "type": "VARCHAR(30)", "key": None, "references": None},
                {"name": "is_cancelled", "type": "TINYINT(1)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_date",
            "kind": "dimension",
            "columns": [
                {"name": "date_key", "type": "INT", "key": "PK", "references": None},
                {"name": "full_date", "type": "DATE", "key": None, "references": None},
                {"name": "day_number", "type": "INT", "key": None, "references": None},
                {"name": "month_number", "type": "INT", "key": None, "references": None},
                {"name": "month_name", "type": "VARCHAR(15)", "key": None, "references": None},
                {"name": "quarter", "type": "INT", "key": None, "references": None},
                {"name": "year_number", "type": "INT", "key": None, "references": None},
                {"name": "week_of_year", "type": "INT", "key": None, "references": None},
                {"name": "day_name", "type": "VARCHAR(15)", "key": None, "references": None},
                {"name": "is_weekend", "type": "TINYINT(1)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_station",
            "kind": "dimension",
            "columns": [
                {"name": "station_key", "type": "INT", "key": "PK", "references": None},
                {"name": "station_code", "type": "VARCHAR(20)", "key": None, "references": None},
                {"name": "station_name", "type": "VARCHAR(100)", "key": None, "references": None},
                {"name": "city", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "railway_line", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "zone", "type": "VARCHAR(50)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_train",
            "kind": "dimension",
            "columns": [
                {"name": "train_key", "type": "INT", "key": "PK", "references": None},
                {"name": "train_number", "type": "VARCHAR(20)", "key": None, "references": None},
                {"name": "train_name", "type": "VARCHAR(100)", "key": None, "references": None},
                {"name": "train_type", "type": "VARCHAR(50)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_passenger",
            "kind": "dimension",
            "columns": [
                {"name": "passenger_key", "type": "INT", "key": "PK", "references": None},
                {"name": "passenger_type", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "age_group", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "gender", "type": "VARCHAR(20)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_ticket",
            "kind": "dimension",
            "columns": [
                {"name": "ticket_key", "type": "INT", "key": "PK", "references": None},
                {"name": "ticket_type", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "booking_mode", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "payment_method", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "class_type", "type": "VARCHAR(50)", "key": None, "references": None},
            ]
        },
        {
            "name": "dim_route",
            "kind": "dimension",
            "columns": [
                {"name": "route_key", "type": "INT", "key": "PK", "references": None},
                {"name": "source_station_key", "type": "INT", "key": "FK", "references": "dim_station.station_key"},
                {"name": "dest_station_key", "type": "INT", "key": "FK", "references": "dim_station.station_key"},
                {"name": "route_name", "type": "VARCHAR(120)", "key": None, "references": None},
                {"name": "railway_line", "type": "VARCHAR(50)", "key": None, "references": None},
                {"name": "distance_km", "type": "DECIMAL(6,2)", "key": None, "references": None},
            ]
        }
    ],
    "indexes": [
        {"table": "fact_bookings", "columns": "date_key", "reason": "Accelerates time-dimension roll-up and drill-down joins", "ddl": "CREATE INDEX idx_fact_date ON fact_bookings(date_key);"},
        {"table": "fact_bookings", "columns": "route_key", "reason": "Optimizes geographic and station-pair slicing", "ddl": "CREATE INDEX idx_fact_route ON fact_bookings(route_key);"},
        {"table": "fact_bookings", "columns": "ticket_key", "reason": "Speeds up class and payment type aggregation", "ddl": "CREATE INDEX idx_fact_ticket ON fact_bookings(ticket_key);"},
        {"table": "dim_date", "columns": "year_number, month_number", "reason": "Fast monthly and quarterly roll-up lookups", "ddl": "CREATE INDEX idx_dim_date_ym ON dim_date(year_number, month_number);"},
        {"table": "dim_station", "columns": "railway_line, city", "reason": "Supports line and suburban network filtering", "ddl": "CREATE INDEX idx_station_line_city ON dim_station(railway_line, city);"}
    ],
    "sample_queries": [
        {
            "id": "q1",
            "title": "Monthly Passenger Traffic and Total Revenue",
            "sql": """SELECT d.year_number, d.month_name,
       SUM(f.passengers_count) AS total_passengers,
       ROUND(SUM(f.fare_amount), 2) AS total_revenue,
       ROUND(AVG(f.fare_amount), 2) AS avg_ticket_fare
FROM fact_bookings f
JOIN dim_date d ON f.date_key = d.date_key
GROUP BY d.year_number, d.month_number, d.month_name
ORDER BY d.year_number, d.month_number;""",
            "explanation": "Executes a Roll-Up OLAP aggregation from daily bookings to monthly totals, computing passenger volume and revenue trends across months."
        },
        {
            "id": "q2",
            "title": "Top 10 Railway Routes by Passenger Volume",
            "sql": """SELECT r.route_name, r.railway_line,
       COUNT(f.booking_fact_id) AS total_bookings,
       SUM(f.passengers_count) AS total_passengers,
       ROUND(SUM(f.fare_amount), 2) AS total_revenue
FROM fact_bookings f
JOIN dim_route r ON f.route_key = r.route_key
GROUP BY r.route_key, r.route_name, r.railway_line
ORDER BY total_passengers DESC
LIMIT 10;""",
            "explanation": "Identifies the highest demand passenger corridors (e.g. CST -> Kurla, Churchgate -> Borivali) for capacity planning and rakes scheduling."
        },
        {
            "id": "q3",
            "title": "Ticket Type vs Booking Mode Breakdown",
            "sql": """SELECT t.ticket_type, t.booking_mode, t.payment_method,
       COUNT(f.booking_fact_id) AS booking_count,
       SUM(f.passengers_count) AS total_passengers,
       ROUND(SUM(f.fare_amount), 2) AS total_revenue
FROM fact_bookings f
JOIN dim_ticket t ON f.ticket_key = t.ticket_key
GROUP BY t.ticket_type, t.booking_mode, t.payment_method
ORDER BY booking_count DESC;""",
            "explanation": "Analyzes the adoption of digital paperless ticketing (UTS mobile) vs paper counters, and payment channel penetration across ticket classes."
        },
        {
            "id": "q4",
            "title": "Station Passenger Traffic Inflow & Outflow",
            "sql": """SELECT s.station_name, s.railway_line, s.city,
       COUNT(f.booking_fact_id) AS originating_bookings,
       SUM(f.passengers_count) AS departing_passengers,
       ROUND(SUM(f.fare_amount), 2) AS station_revenue
FROM fact_bookings f
JOIN dim_station s ON f.source_station_key = s.station_key
GROUP BY s.station_key, s.station_name, s.railway_line, s.city
ORDER BY departing_passengers DESC
LIMIT 10;""",
            "explanation": "Calculates passenger origin load for crowd management, platform optimization, and automatic ticket vending machine (ATVM) deployment."
        }
    ]
}

def init_tables():
    """Initializes tables in the active database engine (MySQL or SQLite)."""
    engine, db_type = get_db_engine()
    with engine.begin() as conn:
        if db_type == "sqlite":
            conn.execute(text("PRAGMA foreign_keys = ON;"))
            # SQLite table creation
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_date (
                date_key INTEGER PRIMARY KEY,
                full_date TEXT NOT NULL UNIQUE,
                day_number INTEGER,
                month_number INTEGER,
                month_name TEXT,
                quarter INTEGER,
                year_number INTEGER,
                week_of_year INTEGER,
                day_of_week INTEGER,
                day_name TEXT,
                is_weekend INTEGER DEFAULT 0
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_station (
                station_key INTEGER PRIMARY KEY AUTOINCREMENT,
                station_code TEXT NOT NULL UNIQUE,
                station_name TEXT NOT NULL,
                city TEXT DEFAULT 'Mumbai',
                railway_line TEXT DEFAULT 'Central',
                zone TEXT DEFAULT 'Central Railway'
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_train (
                train_key INTEGER PRIMARY KEY AUTOINCREMENT,
                train_number TEXT NOT NULL UNIQUE,
                train_name TEXT NOT NULL,
                train_type TEXT DEFAULT 'Local Suburban'
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_passenger (
                passenger_key INTEGER PRIMARY KEY AUTOINCREMENT,
                passenger_type TEXT DEFAULT 'Regular',
                age_group TEXT DEFAULT 'Adult (26-59)',
                gender TEXT DEFAULT 'Unknown'
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_ticket (
                ticket_key INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_type TEXT NOT NULL,
                booking_mode TEXT NOT NULL,
                payment_method TEXT NOT NULL,
                class_type TEXT DEFAULT 'Second Class',
                UNIQUE(ticket_type, booking_mode, payment_method, class_type)
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dim_route (
                route_key INTEGER PRIMARY KEY AUTOINCREMENT,
                source_station_key INTEGER,
                dest_station_key INTEGER,
                route_name TEXT NOT NULL,
                railway_line TEXT DEFAULT 'Central',
                distance_km REAL DEFAULT 0.0,
                FOREIGN KEY (source_station_key) REFERENCES dim_station(station_key),
                FOREIGN KEY (dest_station_key) REFERENCES dim_station(station_key),
                UNIQUE(source_station_key, dest_station_key)
            );"""))
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fact_bookings (
                booking_fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
                booking_id TEXT NOT NULL,
                date_key INTEGER NOT NULL,
                time_of_day TEXT,
                source_station_key INTEGER NOT NULL,
                dest_station_key INTEGER NOT NULL,
                route_key INTEGER,
                ticket_key INTEGER NOT NULL,
                train_key INTEGER,
                passenger_key INTEGER,
                passengers_count INTEGER NOT NULL DEFAULT 1,
                fare_amount REAL NOT NULL DEFAULT 0.0,
                booking_status TEXT NOT NULL DEFAULT 'Confirmed',
                is_cancelled INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
                FOREIGN KEY (source_station_key) REFERENCES dim_station(station_key),
                FOREIGN KEY (dest_station_key) REFERENCES dim_station(station_key),
                FOREIGN KEY (route_key) REFERENCES dim_route(route_key),
                FOREIGN KEY (ticket_key) REFERENCES dim_ticket(ticket_key),
                FOREIGN KEY (train_key) REFERENCES dim_train(train_key),
                FOREIGN KEY (passenger_key) REFERENCES dim_passenger(passenger_key)
            );"""))
        else:
            # MySQL: run through schema.sql statements
            ddl_content = DDL_FILE.read_text(encoding="utf-8")
            statements = [s.strip() for s in ddl_content.split(";") if s.strip()]
            for stmt in statements:
                # Skip CREATE DATABASE or USE statements if connecting to configured database
                lower = stmt.lower()
                if lower.startswith("create database") or lower.startswith("use "):
                    continue
                conn.execute(text(stmt))

def get_table_row_counts():
    """Returns row counts for all warehouse tables."""
    engine, _ = get_db_engine()
    counts = {}
    init_tables()
    with engine.connect() as conn:
        for t in ["fact_bookings", "dim_date", "dim_station", "dim_train", "dim_passenger", "dim_ticket", "dim_route"]:
            try:
                res = conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar()
                counts[t] = int(res)
            except Exception:
                counts[t] = 0
    return counts

def get_schema_response():
    """Generates the response for GET /api/warehouse/schema."""
    init_tables()
    counts = get_table_row_counts()
    ddl = DDL_FILE.read_text(encoding="utf-8") if DDL_FILE.exists() else ""
    
    tables_copy = []
    for t in STAR_SCHEMA_DEFINITION["tables"]:
        t_copy = dict(t)
        t_copy["rows"] = counts.get(t["name"], 0)
        tables_copy.append(t_copy)

    return {
        "grain": STAR_SCHEMA_DEFINITION["grain"],
        "tables": tables_copy,
        "ddl": ddl,
        "indexes": STAR_SCHEMA_DEFINITION["indexes"],
        "sample_queries": STAR_SCHEMA_DEFINITION["sample_queries"]
    }

def run_sample_query(query_id: str):
    """Executes one of the whitelisted sample queries."""
    match = next((q for q in STAR_SCHEMA_DEFINITION["sample_queries"] if q["id"] == query_id), None)
    if not match:
        raise ValueError(f"Unknown sample query ID: {query_id}")

    init_tables()
    engine, _ = get_db_engine()
    with engine.connect() as conn:
        result = conn.execute(text(match["sql"]))
        columns = list(result.keys())
        rows = [list(r) for r in result.fetchall()]
        return {"columns": columns, "rows": rows}
