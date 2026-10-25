"""Data Preprocessing Engine for RailInsight.
Implements Cleaning, Integration, Transformation, Reduction, and Discretization
with before-and-after state comparisons and academic explanations.
"""
from pathlib import Path
import pandas as pd
import numpy as np
from sklearn.preprocessing import MinMaxScaler, StandardScaler, RobustScaler, LabelEncoder
from sklearn.decomposition import PCA
from sklearn.feature_selection import VarianceThreshold

from backend.config import RAW_DATA_DIR, PROCESSED_DATA_DIR

class PreprocessingManager:
    def __init__(self):
        self._raw_df = None
        self._curr_df = None
        self._history = []

    def set_dataset(self, df: pd.DataFrame):
        self._raw_df = df.copy()
        self._curr_df = df.copy()
        self._history = []

    def get_current_df(self) -> pd.DataFrame:
        if self._curr_df is None:
            raw_files = list(RAW_DATA_DIR.glob("*.csv"))
            if raw_files:
                latest = max(raw_files, key=lambda f: f.stat().st_mtime)
                self.set_dataset(pd.read_csv(latest))
            else:
                return pd.DataFrame()
        return self._curr_df

    def reset(self):
        if self._raw_df is not None:
            self._curr_df = self._raw_df.copy()
            self._history = []

    def get_comparison(self):
        raw = self._raw_df if self._raw_df is not None else self.get_current_df()
        curr = self.get_current_df()

        if raw.empty:
            return {
                "raw": {"rows": 0, "columns": 0, "missing_cells": 0, "duplicates": 0},
                "processed": {"rows": 0, "columns": 0, "missing_cells": 0, "duplicates": 0},
                "columns_added": [],
                "columns_removed": [],
                "history": []
            }

        raw_cols = set(raw.columns)
        curr_cols = set(curr.columns)

        return {
            "raw": {
                "rows": len(raw),
                "columns": len(raw.columns),
                "missing_cells": int(raw.isna().sum().sum()),
                "duplicates": int(raw.duplicated().sum())
            },
            "processed": {
                "rows": len(curr),
                "columns": len(curr.columns),
                "missing_cells": int(curr.isna().sum().sum()),
                "duplicates": int(curr.duplicated().sum())
            },
            "columns_added": list(curr_cols - raw_cols),
            "columns_removed": list(raw_cols - curr_cols),
            "history": self._history
        }

    def run_operation(self, category: str, operation: str, params: dict):
        df = self.get_current_df()
        if df.empty:
            raise ValueError("No active dataset loaded for preprocessing.")

        before_sample = {
            "columns": list(df.columns),
            "rows": [list(r) for r in df.head(10).values],
            "title": "Before Operation"
        }

        warnings = []
        stats = {}
        charts = []
        message = ""
        changed = False
        work_df = df.copy()

        # ---------------- 1. Cleaning ----------------
        if category == "cleaning":
            if operation == "detect_missing":
                missing_series = work_df.isna().sum()
                message = f"Missing values detected across {len(work_df.columns)} columns."
                stats = {col: int(cnt) for col, cnt in missing_series.items() if cnt > 0}
                charts.append({
                    "type": "bar",
                    "labels": list(missing_series.index),
                    "values": [int(v) for v in missing_series.values],
                    "title": "Missing Cells Count by Column",
                    "x_label": "Column",
                    "y_label": "Missing Count"
                })

            elif operation == "impute":
                cols = params.get("columns", [])
                method = params.get("method", "median")
                imputed_count = 0
                for c in cols:
                    if c in work_df.columns:
                        na_count = work_df[c].isna().sum()
                        if na_count > 0:
                            if method == "mean" and pd.api.types.is_numeric_dtype(work_df[c]):
                                fill_val = work_df[c].mean()
                            elif method == "median" and pd.api.types.is_numeric_dtype(work_df[c]):
                                fill_val = work_df[c].median()
                            else:
                                fill_val = work_df[c].mode()[0] if not work_df[c].mode().empty else "Unknown"
                            work_df[c] = work_df[c].fillna(fill_val)
                            imputed_count += na_count
                message = f"Imputed {imputed_count} missing cells using {method} strategy."
                changed = True

            elif operation == "remove_duplicates":
                subset = params.get("subset") or None
                keep = params.get("keep", "first")
                initial_len = len(work_df)
                work_df = work_df.drop_duplicates(subset=subset, keep=keep)
                removed = initial_len - len(work_df)
                message = f"Removed {removed} duplicate rows (retained {len(work_df)} records)."
                changed = True

            elif operation == "fix_dtypes":
                col = params.get("column")
                target_type = params.get("target_type", "numeric")
                date_fmt = params.get("date_format")
                if col in work_df.columns:
                    if target_type == "numeric":
                        work_df[col] = pd.to_numeric(work_df[col], errors="coerce")
                    elif target_type == "datetime":
                        work_df[col] = pd.to_datetime(work_df[col], format=date_fmt, errors="coerce")
                    elif target_type == "category":
                        work_df[col] = work_df[col].astype("category")
                    elif target_type == "string":
                        work_df[col] = work_df[col].astype(str)
                message = f"Converted column '{col}' to {target_type}."
                changed = True

            elif operation == "standardize_values":
                cols = params.get("columns", [])
                case = params.get("case", "title")
                trim = params.get("trim", True)
                for c in cols:
                    if c in work_df.columns:
                        s = work_df[c].astype(str)
                        if trim:
                            s = s.str.strip().replace(r'\s+', ' ', regex=True)
                        if case == "lower":
                            s = s.str.lower()
                        elif case == "upper":
                            s = s.str.upper()
                        elif case == "title":
                            s = s.str.title()
                        work_df[c] = s
                message = f"Standardized string casing and whitespace in {len(cols)} columns."
                changed = True

            elif operation == "outliers":
                col = params.get("column")
                method = params.get("method", "iqr")
                threshold = float(params.get("threshold", 1.5))
                action = params.get("action", "flag")
                if col in work_df.columns and pd.api.types.is_numeric_dtype(work_df[col]):
                    s = work_df[col].dropna()
                    if method == "iqr":
                        q1 = s.quantile(0.25)
                        q3 = s.quantile(0.75)
                        iqr = q3 - q1
                        lower_bound = q1 - threshold * iqr
                        upper_bound = q3 + threshold * iqr
                    else:
                        mean = s.mean()
                        std = s.std() or 1.0
                        lower_bound = mean - threshold * std
                        upper_bound = mean + threshold * std

                    is_outlier = (work_df[col] < lower_bound) | (work_df[col] > upper_bound)
                    outlier_count = int(is_outlier.sum())

                    if action == "flag":
                        work_df[f"{col}_outlier"] = is_outlier.astype(int)
                        message = f"Flagged {outlier_count} outliers in new column '{col}_outlier'."
                    elif action == "remove":
                        work_df = work_df[~is_outlier]
                        message = f"Removed {outlier_count} outlier rows from '{col}'."
                    elif action == "cap":
                        work_df[col] = work_df[col].clip(lower=lower_bound, upper=upper_bound)
                        message = f"Capped {outlier_count} outliers in '{col}' to [{round(lower_bound, 2)}, {round(upper_bound, 2)}]."
                    changed = True

        # ---------------- 2. Transformation ----------------
        elif category == "transformation":
            if operation == "minmax":
                cols = params.get("columns", [])
                new_min = float(params.get("new_min", 0))
                new_max = float(params.get("new_max", 1))
                valid_cols = [c for c in cols if c in work_df.columns and pd.api.types.is_numeric_dtype(work_df[c])]
                if valid_cols:
                    scaler = MinMaxScaler(feature_range=(new_min, new_max))
                    work_df[valid_cols] = scaler.fit_transform(work_df[valid_cols].fillna(work_df[valid_cols].median()))
                    message = f"Applied Min-Max normalization [{new_min}, {new_max}] to {len(valid_cols)} columns."
                    changed = True

            elif operation == "zscore":
                cols = params.get("columns", [])
                valid_cols = [c for c in cols if c in work_df.columns and pd.api.types.is_numeric_dtype(work_df[c])]
                if valid_cols:
                    scaler = StandardScaler()
                    work_df[valid_cols] = scaler.fit_transform(work_df[valid_cols].fillna(work_df[valid_cols].median()))
                    message = f"Standardized {len(valid_cols)} columns (mean=0, std=1)."
                    changed = True

            elif operation == "robust_scale":
                cols = params.get("columns", [])
                valid_cols = [c for c in cols if c in work_df.columns and pd.api.types.is_numeric_dtype(work_df[c])]
                if valid_cols:
                    scaler = RobustScaler()
                    work_df[valid_cols] = scaler.fit_transform(work_df[valid_cols].fillna(work_df[valid_cols].median()))
                    message = f"Applied Robust Scaling (median/IQR) to {len(valid_cols)} columns."
                    changed = True

            elif operation == "label_encode":
                cols = params.get("columns", [])
                for c in cols:
                    if c in work_df.columns:
                        le = LabelEncoder()
                        work_df[c] = le.fit_transform(work_df[c].astype(str))
                message = f"Label encoded {len(cols)} categorical columns to numeric identifiers."
                changed = True

            elif operation == "one_hot":
                cols = params.get("columns", [])
                drop_first = params.get("drop_first", False)
                max_cat = int(params.get("max_categories", 30))
                cols_to_encode = [c for c in cols if c in work_df.columns and work_df[c].nunique() <= max_cat]
                if cols_to_encode:
                    work_df = pd.get_dummies(work_df, columns=cols_to_encode, drop_first=drop_first, dtype=int)
                    message = f"One-hot encoded {len(cols_to_encode)} columns."
                    changed = True
                else:
                    warnings.append("Selected columns exceed max categories threshold.")

            elif operation == "date_features":
                col = params.get("column")
                features = params.get("features", ["year", "month", "quarter", "weekday"])
                if col in work_df.columns:
                    dt_series = pd.to_datetime(work_df[col], errors="coerce")
                    if "year" in features:
                        work_df[f"{col}_year"] = dt_series.dt.year
                    if "month" in features:
                        work_df[f"{col}_month"] = dt_series.dt.month
                    if "quarter" in features:
                        work_df[f"{col}_quarter"] = dt_series.dt.quarter
                    if "day" in features:
                        work_df[f"{col}_day"] = dt_series.dt.day
                    if "weekday" in features:
                        work_df[f"{col}_weekday"] = dt_series.dt.day_name()
                    if "is_weekend" in features:
                        work_df[f"{col}_is_weekend"] = dt_series.dt.dayofweek.isin([5, 6]).astype(int)
                    message = f"Extracted temporal features ({', '.join(features)}) from '{col}'."
                    changed = True

        # ---------------- 3. Reduction ----------------
        elif category == "reduction":
            if operation == "pca":
                cols = params.get("columns", [])
                n_comp = int(params.get("n_components", 2))
                standardize = params.get("standardize", True)
                valid_cols = [c for c in cols if c in work_df.columns and pd.api.types.is_numeric_dtype(work_df[c])]
                if len(valid_cols) >= n_comp:
                    data = work_df[valid_cols].fillna(work_df[valid_cols].median())
                    if standardize:
                        data = StandardScaler().fit_transform(data)
                    pca = PCA(n_components=n_comp)
                    comps = pca.fit_transform(data)
                    for i in range(n_comp):
                        work_df[f"PCA_Comp_{i+1}"] = comps[:, i]
                    exp_var = [round(float(v) * 100, 2) for v in pca.explained_variance_ratio_]
                    message = f"Computed {n_comp} Principal Components. Explained variance: {exp_var}%."
                    changed = True
                else:
                    warnings.append(f"PCA requires at least {n_comp} numerical columns.")

            elif operation == "sampling":
                method = params.get("method", "random")
                frac = float(params.get("fraction", 0.1))
                seed = int(params.get("seed", 42))
                strat = params.get("stratify_by")
                if method == "stratified" and strat and strat in work_df.columns:
                    work_df = work_df.groupby(strat, group_keys=False).apply(lambda x: x.sample(frac=frac, random_state=seed))
                else:
                    work_df = work_df.sample(frac=frac, random_state=seed)
                message = f"Sampled {len(work_df)} records ({int(frac*100)}% of original data) using {method} sampling."
                changed = True

        # ---------------- 4. Discretization ----------------
        elif category == "discretization":
            col = params.get("column")
            bins = int(params.get("bins", 5))
            if col in work_df.columns and pd.api.types.is_numeric_dtype(work_df[col]):
                if operation == "equal_width":
                    work_df[f"{col}_bin_width"] = pd.cut(work_df[col], bins=bins).astype(str)
                    message = f"Equal-width discretization: Created {bins} bins for '{col}'."
                    changed = True
                elif operation == "equal_frequency":
                    work_df[f"{col}_bin_freq"] = pd.qcut(work_df[col], q=bins, duplicates="drop").astype(str)
                    message = f"Equal-frequency (quantile) discretization: Created {bins} bins for '{col}'."
                    changed = True
                elif operation == "custom_bins":
                    edges_str = params.get("edges", "")
                    edges = [float(e.strip()) for e in edges_str.split(",") if e.strip()]
                    labels_str = params.get("labels", "")
                    labels = [l.strip() for l in labels_str.split(",") if l.strip()] or None
                    if len(edges) >= 2:
                        work_df[f"{col}_custom_bin"] = pd.cut(work_df[col], bins=edges, labels=labels).astype(str)
                        message = f"Custom binning: Partitioned '{col}' using edges {edges}."
                        changed = True

        if changed:
            self._curr_df = work_df
            self._history.append({"operation": operation, "category": category, "desc": message})

        after_sample = {
            "columns": list(work_df.columns),
            "rows": [list(r) for r in work_df.head(10).values],
            "title": "After Operation"
        }

        return {
            "message": message or "Operation completed.",
            "warnings": warnings,
            "stats": stats,
            "before": before_sample,
            "after": after_sample,
            "charts": charts,
            "changed": changed
        }

preprocessing_manager = PreprocessingManager()
