"""Prediction and Forecasting Engine for RailInsight.
Implements chronological time-series forecasting (Passenger Demand, Booking Volume, Revenue)
using Linear Trend, Ridge with Autoregressive Lags, Random Forest, and Exponential Smoothing.
Never invents data; enforces chronological train-test splits and reports MAE, RMSE, R2, and baseline error.
"""
import pandas as pd
import numpy as np
from datetime import timedelta
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

def get_forecast_options(df: pd.DataFrame):
    has_date = False
    for c in df.columns:
        if c.lower() in ["date", "journey_date", "travel_date"]:
            has_date = True
            break
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            has_date = True
            break

    col_map = {c.lower(): c for c in df.columns}
    has_pax = any(k in col_map for k in ["passengers", "passenger", "pax"])
    has_fare = any(k in col_map for k in ["total_fare", "fare", "amount", "revenue"])

    targets = [
        {
            "key": "passengers",
            "label": "Passenger Demand",
            "available": has_date and has_pax,
            "reason": "Requires mapped Date and Passengers columns." if not (has_date and has_pax) else None
        },
        {
            "key": "revenue",
            "label": "Fare Revenue",
            "available": has_date and has_fare,
            "reason": "Requires mapped Date and Fare columns." if not (has_date and has_fare) else None
        },
        {
            "key": "bookings",
            "label": "Daily Bookings Count",
            "available": has_date,
            "reason": "Requires mapped Date column." if not has_date else None
        }
    ]

    return {
        "targets": targets,
        "granularities": ["daily", "weekly", "monthly"],
        "models": [
            {"key": "ridge", "label": "Ridge Autoregressive (Lags + Day of Week)"},
            {"key": "random_forest", "label": "Random Forest Time-Series Regressor"},
            {"key": "linear", "label": "Linear Trend Regression"},
            {"key": "exp_smoothing", "label": "Exponential Smoothing"}
        ],
        "max_horizon": 60
    }

def run_forecast(df: pd.DataFrame, req: dict):
    target = req.get("target", "passengers")
    granularity = req.get("granularity", "daily")
    model_type = req.get("model", "ridge")
    horizon = int(req.get("horizon", 14))
    test_fraction = float(req.get("test_fraction", 0.2))

    col_map = {c.lower(): c for c in df.columns}
    date_col = None
    for cand in ["date", "journey_date", "travel_date"]:
        if cand in col_map:
            date_col = col_map[cand]
            break

    if not date_col:
        return {"available": False, "reason": "No Date column found in active dataset."}

    # Prepare timeline
    work_df = df.copy()
    work_df["_dt"] = pd.to_datetime(work_df[date_col], errors="coerce")
    work_df = work_df.dropna(subset=["_dt"]).sort_values(by="_dt")

    if target == "passengers":
        pax_col = next((col_map[k] for k in ["passengers", "passenger", "pax"] if k in col_map), None)
        if not pax_col:
            return {"available": False, "reason": "No Passengers column found."}
        work_df["_val"] = pd.to_numeric(work_df[pax_col], errors="coerce").fillna(1)
        unit = "Passengers"
    elif target == "revenue":
        fare_col = next((col_map[k] for k in ["total_fare", "fare", "amount", "revenue"] if k in col_map), None)
        if not fare_col:
            return {"available": False, "reason": "No Fare column found."}
        work_df["_val"] = pd.to_numeric(work_df[fare_col], errors="coerce").fillna(0)
        unit = "INR (₹)"
    else:
        work_df["_val"] = 1
        unit = "Bookings"

    # Aggregate by granularity
    rule_map = {"daily": "D", "weekly": "W", "monthly": "ME"}
    rule = rule_map.get(granularity, "D")
    
    ts = work_df.set_index("_dt")["_val"].resample(rule).sum().fillna(0)
    ts = ts[ts > 0]  # Remove empty leading dates

    if len(ts) < 15:
        return {
            "available": False,
            "reason": f"Only {len(ts)} historical periods available at '{granularity}' granularity. Need at least 15 periods for time-series modeling."
        }

    # Chronological train/test split
    n_total = len(ts)
    n_test = max(3, int(n_total * test_fraction))
    n_train = n_total - n_test

    train_series = ts.iloc[:n_train]
    test_series = ts.iloc[n_train:]

    train_end_label = str(train_series.index[-1].strftime("%Y-%m-%d"))

    # Feature engineering for models
    def create_features(series):
        df_feat = pd.DataFrame(index=series.index)
        df_feat["trend"] = np.arange(len(series))
        df_feat["dayofweek"] = series.index.day_of_week
        df_feat["month"] = series.index.month
        # Lags
        df_feat["lag_1"] = series.shift(1).fillna(series.mean())
        df_feat["lag_2"] = series.shift(2).fillna(series.mean())
        df_feat["lag_7"] = series.shift(7).fillna(series.mean())
        df_feat["rolling_mean_7"] = series.rolling(7, min_periods=1).mean().shift(1).fillna(series.mean())
        return df_feat

    X_train = create_features(train_series)
    y_train = train_series.values

    # Fit model
    if model_type == "linear":
        model = LinearRegression()
        model.fit(X_train[["trend", "dayofweek"]], y_train)
    elif model_type == "random_forest":
        model = RandomForestRegressor(n_estimators=40, max_depth=5, random_state=42)
        model.fit(X_train, y_train)
    elif model_type == "exp_smoothing":
        # Simple exponential smoothing emulation
        alpha = 0.3
        smoothed = [y_train[0]]
        for val in y_train[1:]:
            smoothed.append(alpha * val + (1 - alpha) * smoothed[-1])
        last_val = smoothed[-1]
    else:  # ridge
        model = Ridge(alpha=1.0)
        model.fit(X_train, y_train)

    # Predict test period
    if model_type == "exp_smoothing":
        test_preds = np.repeat(last_val, len(test_series))
    elif model_type == "linear":
        X_test = create_features(ts).iloc[n_train:][["trend", "dayofweek"]]
        test_preds = np.maximum(0, model.predict(X_test))
    else:
        X_test = create_features(ts).iloc[n_train:]
        test_preds = np.maximum(0, model.predict(X_test))

    # Calculate metrics
    y_true_test = test_series.values
    mae = round(float(mean_absolute_error(y_true_test, test_preds)), 2)
    rmse = round(float(np.sqrt(mean_squared_error(y_true_test, test_preds))), 2)
    r2 = round(float(r2_score(y_true_test, test_preds)), 3)

    # Baseline: naive "last observation carried forward"
    baseline_pred = np.repeat(y_train[-1], len(test_series))
    baseline_mae = round(float(mean_absolute_error(y_true_test, baseline_pred)), 2)

    # Generate future horizon dates
    last_dt = ts.index[-1]
    freq_offset = {"daily": timedelta(days=1), "weekly": timedelta(weeks=1), "monthly": timedelta(days=30)}[granularity]
    future_dates = [last_dt + freq_offset * (i + 1) for i in range(horizon)]
    future_labels = [d.strftime("%Y-%m-%d") for d in future_dates]

    # Future forecast
    future_features = pd.DataFrame(index=future_dates)
    future_features["trend"] = np.arange(n_total, n_total + horizon)
    future_features["dayofweek"] = [d.day_of_week for d in future_dates]
    future_features["month"] = [d.month for d in future_dates]
    future_features["lag_1"] = ts.iloc[-1]
    future_features["lag_2"] = ts.iloc[-2] if len(ts) > 1 else ts.iloc[-1]
    future_features["lag_7"] = ts.iloc[-7] if len(ts) > 6 else ts.iloc[-1]
    future_features["rolling_mean_7"] = ts.iloc[-7:].mean()

    if model_type == "exp_smoothing":
        fc_values = [round(float(last_val), 1)] * horizon
    elif model_type == "linear":
        fc_raw = model.predict(future_features[["trend", "dayofweek"]])
        fc_values = [round(float(max(0, v)), 1) for v in fc_raw]
    else:
        fc_raw = model.predict(future_features)
        fc_values = [round(float(max(0, v)), 1) for v in fc_raw]

    # Confidence interval bounds (approx ± 1.96 * RMSE)
    margin = 1.96 * rmse
    lower_bounds = [round(float(max(0, v - margin)), 1) for v in fc_values]
    upper_bounds = [round(float(v + margin), 1) for v in fc_values]

    # Format history and test
    hist_labels = [d.strftime("%Y-%m-%d") for d in ts.index]
    hist_values = [round(float(v), 1) for v in ts.values]
    test_labels = [d.strftime("%Y-%m-%d") for d in test_series.index]
    test_preds_list = [round(float(v), 1) for v in test_preds]

    # Forecast table
    fc_table_rows = []
    for i in range(horizon):
        fc_table_rows.append([
            future_labels[i],
            fc_values[i],
            lower_bounds[i],
            upper_bounds[i]
        ])

    return {
        "available": True,
        "history": {"labels": hist_labels, "values": hist_values},
        "test": {"labels": test_labels, "predicted": test_preds_list},
        "forecast": {
            "labels": future_labels,
            "values": fc_values,
            "lower": lower_bounds,
            "upper": upper_bounds
        },
        "metrics": {
            "MAE": mae,
            "RMSE": rmse,
            "R2": r2,
            "baseline_MAE": baseline_mae
        },
        "split": {"train_end": train_end_label},
        "unit": unit,
        "forecast_table": {
            "columns": ["Period", "Forecast", "Lower 95% Bound", "Upper 95% Bound"],
            "rows": fc_table_rows
        },
        "warnings": []
    }
