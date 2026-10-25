"""Machine Learning Classification module for RailInsight.
Implements Decision Tree, Random Forest, Logistic Regression, KNN, and Naive Bayes
with train-test evaluation, confusion matrices, baseline comparison, and feature importance.
"""
import time
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.metrics import accuracy_score, precision_recall_fscore_support, confusion_matrix

ALGO_FACTORY = {
    "decision_tree": lambda seed: DecisionTreeClassifier(max_depth=6, random_state=seed),
    "random_forest": lambda seed: RandomForestClassifier(n_estimators=50, max_depth=6, random_state=seed, n_jobs=-1),
    "logistic_regression": lambda seed: LogisticRegression(max_iter=1000, random_state=seed),
    "knn": lambda seed: KNeighborsClassifier(n_neighbors=5),
    "naive_bayes": lambda seed: GaussianNB(),
}

ALGO_NAMES = {
    "decision_tree": "Decision Tree",
    "random_forest": "Random Forest",
    "logistic_regression": "Logistic Regression",
    "knn": "K-Nearest Neighbors",
    "naive_bayes": "Naive Bayes"
}

def run_classification(df: pd.DataFrame, req: dict):
    target = req.get("target")
    features = req.get("features", [])
    algos = req.get("algorithms", ["decision_tree", "random_forest"])
    test_size = float(req.get("test_size", 0.2))
    sample_size = int(req.get("sample_size", 50000))
    random_state = int(req.get("random_state", 42))

    if not target or target not in df.columns:
        raise ValueError(f"Target column '{target}' not found in dataset.")
    if not features:
        raise ValueError("At least one feature column must be selected.")

    # Drop target nulls
    clean_df = df.dropna(subset=[target]).copy()
    if len(clean_df) > sample_size:
        clean_df = clean_df.sample(n=sample_size, random_state=random_state)

    y_raw = clean_df[target].astype(str)
    classes = sorted(list(y_raw.unique()))
    if len(classes) < 2:
        raise ValueError(f"Target column '{target}' must have at least 2 distinct classes.")

    # Majority baseline accuracy
    counts = y_raw.value_counts()
    majority_acc = round(float(counts.iloc[0] / len(y_raw)), 4)

    # Encode X features
    X_raw = clean_df[features].copy()
    num_cols = [c for c in features if pd.api.types.is_numeric_dtype(X_raw[c])]
    cat_cols = [c for c in features if c not in num_cols]

    # Impute numeric
    for c in num_cols:
        X_raw[c] = pd.to_numeric(X_raw[c], errors="coerce").fillna(X_raw[c].median() if not X_raw[c].isna().all() else 0)

    # Impute & one-hot categorical
    if cat_cols:
        for c in cat_cols:
            X_raw[c] = X_raw[c].astype(str).fillna("Unknown")
        X_encoded = pd.get_dummies(X_raw, columns=cat_cols, drop_first=True, dtype=float)
    else:
        X_encoded = X_raw.astype(float)

    # Split
    X_train, X_test, y_train, y_test = train_test_split(
        X_encoded, y_raw, test_size=test_size, random_state=random_state, stratify=y_raw
    )

    results = []
    warnings = []

    for a_key in algos:
        if a_key not in ALGO_FACTORY:
            continue
        try:
            t0 = time.time()
            model = ALGO_FACTORY[a_key](random_state)
            X_tr, X_te = X_train, X_test
            if a_key in ["logistic_regression", "knn"]:
                from sklearn.preprocessing import StandardScaler
                scaler = StandardScaler()
                X_tr = scaler.fit_transform(X_train)
                X_te = scaler.transform(X_test)
            model.fit(X_tr, y_train)
            dur = round(time.time() - t0, 3)

            y_pred = model.predict(X_te)
            acc = round(float(accuracy_score(y_test, y_pred)), 4)
            p_macro, r_macro, f1_macro, _ = precision_recall_fscore_support(y_test, y_pred, average="weighted", zero_division=0)
            
            # Confusion matrix
            cm = confusion_matrix(y_test, y_pred, labels=classes)
            cm_matrix = [[int(val) for val in row] for row in cm]

            # Detailed classification report per class
            p_class, r_class, f1_class, s_class = precision_recall_fscore_support(y_test, y_pred, labels=classes, zero_division=0)
            report = []
            for i, c_name in enumerate(classes):
                report.append({
                    "label": c_name,
                    "precision": round(float(p_class[i]), 3),
                    "recall": round(float(r_class[i]), 3),
                    "f1": round(float(f1_class[i]), 3),
                    "support": int(s_class[i])
                })

            # Feature importance if tree-based
            feat_imp = None
            if hasattr(model, "feature_importances_"):
                importances = model.feature_importances_
                indices = np.argsort(importances)[::-1][:10]
                feat_imp = [
                    {"feature": str(X_encoded.columns[i]), "importance": round(float(importances[i]), 4)}
                    for i in indices if importances[i] > 0
                ]

            results.append({
                "algorithm": ALGO_NAMES.get(a_key, a_key),
                "accuracy": acc,
                "precision": round(float(p_macro), 4),
                "recall": round(float(r_macro), 4),
                "f1": round(float(f1_macro), 4),
                "train_seconds": dur,
                "confusion": {"labels": classes, "matrix": cm_matrix},
                "report": report,
                "feature_importance": feat_imp
            })
        except Exception as ex:
            warnings.append(f"Model {ALGO_NAMES.get(a_key, a_key)} failed: {str(ex)}")

    return {
        "split": {"train": len(X_train), "test": len(X_test)},
        "classes": classes,
        "baseline": {"majority_accuracy": majority_acc},
        "results": results,
        "warnings": warnings
    }
