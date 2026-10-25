"""OLAP Analysis Engine for RailInsight.
Implements Roll-up, Drill-down, Slice, Dice, and Pivot using SQL queries
against the Star Schema Data Warehouse. Whitelists dimensions and measures to prevent SQL injection.
"""
from sqlalchemy import text
import pandas as pd
from backend.config import get_db_engine
from backend.warehouse import init_tables

TIME_LEVELS = [
    {"key": "year", "label": "Year", "col": "d.year_number"},
    {"key": "quarter", "label": "Quarter", "col": "d.quarter"},
    {"key": "month", "label": "Month", "col": "d.month_name"},
    {"key": "day", "label": "Day", "col": "d.full_date"},
]

TIME_HIERARCHY = ["year", "quarter", "month", "day"]

DIM_MAP = {
    "station": {"col": "s_src.station_name", "label": "Origin Station", "join": "JOIN dim_station s_src ON f.source_station_key = s_src.station_key"},
    "destination": {"col": "s_dst.station_name", "label": "Destination Station", "join": "JOIN dim_station s_dst ON f.dest_station_key = s_dst.station_key"},
    "route": {"col": "r.route_name", "label": "Route", "join": "JOIN dim_route r ON f.route_key = r.route_key"},
    "ticket_type": {"col": "t.ticket_type", "label": "Ticket Type", "join": "JOIN dim_ticket t ON f.ticket_key = t.ticket_key"},
    "booking_mode": {"col": "t.booking_mode", "label": "Booking Mode", "join": "JOIN dim_ticket t ON f.ticket_key = t.ticket_key"},
    "payment_method": {"col": "t.payment_method", "label": "Payment Method", "join": "JOIN dim_ticket t ON f.ticket_key = t.ticket_key"},
    "line": {"col": "r.railway_line", "label": "Railway Line", "join": "JOIN dim_route r ON f.route_key = r.route_key"},
    "year": {"col": "d.year_number", "label": "Year", "join": "JOIN dim_date d ON f.date_key = d.date_key", "time": True},
    "quarter": {"col": "d.quarter", "label": "Quarter", "join": "JOIN dim_date d ON f.date_key = d.date_key", "time": True},
    "month": {"col": "d.month_name", "label": "Month", "join": "JOIN dim_date d ON f.date_key = d.date_key", "time": True},
    "day": {"col": "d.full_date", "label": "Day", "join": "JOIN dim_date d ON f.date_key = d.date_key", "time": True},
}

MEASURE_MAP = {
    "bookings": {"expr": "COUNT(f.booking_fact_id)", "label": "Total Bookings"},
    "passengers": {"expr": "SUM(f.passengers_count)", "label": "Total Passengers"},
    "fare": {"expr": "SUM(f.fare_amount)", "label": "Total Revenue"},
    "avg_fare": {"expr": "AVG(f.fare_amount)", "label": "Average Fare"},
}

def get_metadata():
    init_tables()
    engine, _ = get_db_engine()
    
    dimensions = []
    with engine.connect() as conn:
        # Get distinct values for main categorical dimensions
        for key, info in DIM_MAP.items():
            if info.get("time"):
                continue
            try:
                sql = f"SELECT DISTINCT {info['col']} AS val FROM fact_bookings f {info['join']} WHERE {info['col']} IS NOT NULL ORDER BY val LIMIT 50;"
                rows = conn.execute(text(sql)).fetchall()
                vals = [str(r[0]) for r in rows if r[0] is not None]
            except Exception:
                vals = []
            dimensions.append({
                "key": key,
                "label": info["label"],
                "time": False,
                "values": vals
            })

    # Add time dimension entry
    dimensions.append({"key": "year", "label": "Year (Time Hierarchy)", "time": True})
    dimensions.append({"key": "quarter", "label": "Quarter (Time Hierarchy)", "time": True})
    dimensions.append({"key": "month", "label": "Month (Time Hierarchy)", "time": True})
    dimensions.append({"key": "day", "label": "Day (Time Hierarchy)", "time": True})

    measures = [{"key": k, "label": v["label"]} for k, v in MEASURE_MAP.items()]
    aggregations = ["SUM", "COUNT", "AVG", "MIN", "MAX"]

    return {
        "dimensions": dimensions,
        "time_levels": [{"key": l["key"], "label": l["label"]} for l in TIME_LEVELS],
        "measures": measures,
        "aggregations": aggregations
    }

def execute_olap_query(req: dict):
    init_tables()
    engine, _ = get_db_engine()

    operation = req.get("operation", "rollup")
    measure_key = req.get("measure", "passengers")
    agg_op = req.get("agg", "SUM").upper()
    limit = min(int(req.get("limit", 500)), 1000)

    # Base measure expression
    m_info = MEASURE_MAP.get(measure_key, MEASURE_MAP["passengers"])
    if agg_op == "COUNT":
        meas_expr = "COUNT(f.booking_fact_id)"
    elif agg_op == "AVG":
        meas_expr = f"ROUND(AVG(f.fare_amount), 2)" if measure_key in ["fare", "avg_fare"] else f"ROUND(AVG(f.passengers_count), 2)"
    elif agg_op == "MIN":
        meas_expr = f"MIN(f.fare_amount)" if measure_key in ["fare", "avg_fare"] else f"MIN(f.passengers_count)"
    elif agg_op == "MAX":
        meas_expr = f"MAX(f.fare_amount)" if measure_key in ["fare", "avg_fare"] else f"MAX(f.passengers_count)"
    else:
        meas_expr = m_info["expr"]

    meas_alias = "measure_value"
    joins = set(["JOIN dim_date d ON f.date_key = d.date_key"])
    where_clauses = []
    group_by_cols = []
    select_cols = []
    params = {}
    chart = None
    level = None
    next_level = None

    # 1. Roll-up
    if operation == "rollup":
        lvl_key = req.get("level", "month")
        lvl_info = next((l for l in TIME_LEVELS if l["key"] == lvl_key), TIME_LEVELS[2])
        level = lvl_key
        select_cols.append(f"{lvl_info['col']} AS {lvl_key}")
        group_by_cols.append(lvl_info["col"])

        opt_gb = req.get("group_by")
        if opt_gb and opt_gb in DIM_MAP:
            g_info = DIM_MAP[opt_gb]
            joins.add(g_info["join"])
            select_cols.append(f"{g_info['col']} AS {opt_gb}")
            group_by_cols.append(g_info["col"])

    # 2. Drill-down
    elif operation == "drilldown":
        path = req.get("path", [])
        curr_idx = len(path)
        if curr_idx >= len(TIME_HIERARCHY):
            curr_idx = len(TIME_HIERARCHY) - 1

        curr_lvl = TIME_HIERARCHY[curr_idx]
        level = curr_lvl
        next_level = TIME_HIERARCHY[curr_idx + 1] if curr_idx + 1 < len(TIME_HIERARCHY) else None

        lvl_info = next(l for l in TIME_LEVELS if l["key"] == curr_lvl)
        select_cols.append(f"{lvl_info['col']} AS {curr_lvl}")
        group_by_cols.append(lvl_info["col"])

        # Add filters from previous drill levels
        for i, step in enumerate(path):
            s_lvl = step.get("level")
            s_val = step.get("value")
            s_info = next((l for l in TIME_LEVELS if l["key"] == s_lvl), None)
            if s_info:
                p_name = f"drill_p_{i}"
                where_clauses.append(f"{s_info['col']} = :{p_name}")
                params[p_name] = s_val

    # 3. Slice
    elif operation == "slice":
        slice_cfg = req.get("slice", {})
        dim_key = slice_cfg.get("dimension")
        dim_val = slice_cfg.get("value")
        gb_key = req.get("group_by", "route")

        if dim_key in DIM_MAP:
            d_info = DIM_MAP[dim_key]
            joins.add(d_info["join"])
            where_clauses.append(f"{d_info['col']} = :slice_val")
            params["slice_val"] = dim_val

        if gb_key in DIM_MAP:
            g_info = DIM_MAP[gb_key]
            joins.add(g_info["join"])
            select_cols.append(f"{g_info['col']} AS {gb_key}")
            group_by_cols.append(g_info["col"])
        else:
            select_cols.append("d.month_name AS month")
            group_by_cols.append("d.month_name")

    # 4. Dice
    elif operation == "dice":
        dice_conds = req.get("dice", [])
        for i, cond in enumerate(dice_conds):
            d_key = cond.get("dimension")
            vals = cond.get("values", [])
            if d_key in DIM_MAP and vals:
                d_info = DIM_MAP[d_key]
                joins.add(d_info["join"])
                placeholders = []
                for j, v in enumerate(vals):
                    p_name = f"dice_{i}_{j}"
                    params[p_name] = v
                    placeholders.append(f":{p_name}")
                where_clauses.append(f"{d_info['col']} IN ({', '.join(placeholders)})")

        gb_key = req.get("group_by", "ticket_type")
        if gb_key in DIM_MAP:
            g_info = DIM_MAP[gb_key]
            joins.add(g_info["join"])
            select_cols.append(f"{g_info['col']} AS {gb_key}")
            group_by_cols.append(g_info["col"])
        else:
            select_cols.append("d.month_name AS month")
            group_by_cols.append("d.month_name")

    # 5. Pivot
    elif operation == "pivot":
        p_cfg = req.get("pivot", {})
        r_dim = p_cfg.get("rows", "route")
        c_dim = p_cfg.get("columns", "month")

        r_info = DIM_MAP.get(r_dim, DIM_MAP["route"])
        c_info = DIM_MAP.get(c_dim, DIM_MAP["month"])
        joins.add(r_info["join"])
        joins.add(c_info["join"])

        select_cols.append(f"{r_info['col']} AS row_dim")
        select_cols.append(f"{c_info['col']} AS col_dim")
        group_by_cols.append(r_info["col"])
        group_by_cols.append(c_info["col"])

    select_cols.append(f"{meas_expr} AS {meas_alias}")
    
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    group_sql = ("GROUP BY " + ", ".join(group_by_cols)) if group_by_cols else ""
    order_sql = f"ORDER BY {meas_alias} DESC" if operation != "pivot" else "ORDER BY row_dim"
    
    sql = f"""SELECT {', '.join(select_cols)}
FROM fact_bookings f
{' '.join(joins)}
{where_sql}
{group_sql}
{order_sql}
LIMIT {limit};"""

    with engine.connect() as conn:
        res = conn.execute(text(sql), params)
        raw_cols = list(res.keys())
        raw_rows = [list(r) for r in res.fetchall()]

    # If Pivot, reshape into a 2D cross-tab matrix
    if operation == "pivot" and raw_rows:
        df = pd.DataFrame(raw_rows, columns=raw_cols)
        piv = df.pivot_table(index="row_dim", columns="col_dim", values=meas_alias, aggfunc="sum", fill_value=0)
        piv_cols = [r_dim] + [str(c) for c in piv.columns]
        piv_rows = []
        for idx, row in piv.iterrows():
            piv_rows.append([str(idx)] + [round(float(v), 2) for v in row.values])
        
        # Build multi-series bar chart for pivot
        chart_datasets = []
        for i, col_name in enumerate(piv.columns[:6]):
            chart_datasets.append({
                "label": str(col_name),
                "data": [round(float(v), 2) for v in piv[col_name].values[:10]]
            })
        chart = {
            "type": "bar",
            "labels": [str(x) for x in piv.index[:10]],
            "datasets": chart_datasets,
            "x_label": r_dim,
            "y_label": m_info["label"]
        }
        return {
            "sql": sql,
            "params": params,
            "columns": piv_cols,
            "rows": piv_rows,
            "chart": chart,
            "level": level,
            "next_level": next_level,
            "row_count": len(piv_rows),
            "truncated": False
        }

    # Format chart for standard 1D/2D aggregations
    if raw_rows:
        labels = [str(r[0]) for r in raw_rows[:15]]
        values = [round(float(r[-1]), 2) if r[-1] is not None else 0.0 for r in raw_rows[:15]]
        chart = {
            "type": "bar" if operation != "drilldown" else "bar",
            "labels": labels,
            "values": values,
            "x_label": raw_cols[0],
            "y_label": m_info["label"],
            "title": f"{m_info['label']} by {raw_cols[0]}"
        }

    return {
        "sql": sql,
        "params": params,
        "columns": raw_cols,
        "rows": raw_rows,
        "chart": chart,
        "level": level,
        "next_level": next_level,
        "row_count": len(raw_rows),
        "truncated": len(raw_rows) >= limit
    }
