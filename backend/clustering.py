"""Clustering module for RailInsight.
Implements K-Means, Hierarchical (Agglomerative), and DBSCAN segmentation
with Elbow Method (WCSS), Silhouette Score, PCA 2D projections, and cluster profiles.
"""
import pandas as pd
import numpy as np
from sklearn.cluster import KMeans, AgglomerativeClustering, DBSCAN
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA

def run_clustering(df: pd.DataFrame, req: dict):
    algorithm = req.get("algorithm", "kmeans")
    entity = req.get("entity", "routes")
    k = int(req.get("k", 3))
    k_min = int(req.get("k_min", 2))
    k_max = int(req.get("k_max", 7))
    linkage = req.get("linkage", "ward")
    eps = float(req.get("eps", 0.5))
    min_samples = int(req.get("min_samples", 5))
    sample_size = min(int(req.get("sample_size", 5000)), 15000)

    warnings = []
    
    # Aggregate or sample based on entity
    col_map = {c.lower(): c for c in df.columns}
    def get_c(*names):
        for n in names:
            if n.lower() in col_map:
                return col_map[n.lower()]
        return None

    c_route = get_c("route_name", "route")
    c_from = get_c("from_station", "source")
    c_to = get_c("to_station", "destination")
    c_fare = get_c("total_fare", "fare", "amount")
    c_pax = get_c("passengers", "pax")
    c_ticket = get_c("ticket_type", "type")

    # Build clusterable feature matrix
    if entity == "routes" and (c_route or (c_from and c_to)):
        route_col = c_route if c_route else "_route"
        if c_route is None:
            df["_route"] = df[c_from].astype(str) + " -> " + df[c_to].astype(str)
        
        # Group by route and compute features
        agg_dict = {}
        if c_pax:
            agg_dict["avg_pax"] = (c_pax, "mean")
            agg_dict["total_pax"] = (c_pax, "sum")
        if c_fare:
            agg_dict["avg_fare"] = (c_fare, "mean")
            agg_dict["total_revenue"] = (c_fare, "sum")
        agg_dict["booking_count"] = (df.columns[0], "count")

        grouped = df.groupby(route_col).agg(**agg_dict).reset_index()
        feature_cols = [c for c in grouped.columns if c != route_col]
        items_df = grouped
        id_col = route_col
    else:
        # Cluster individual booking transactions
        num_cols = [c for c in [c_pax, c_fare] if c and c in df.columns]
        if not num_cols:
            num_cols = df.select_dtypes(include=[np.number]).columns.tolist()[:3]
        if not num_cols:
            raise ValueError("No numerical features available for clustering.")
        items_df = df.dropna(subset=num_cols).head(sample_size).copy()
        feature_cols = num_cols
        id_col = df.columns[0]

    if len(items_df) < 5:
        raise ValueError("Not enough distinct items to cluster.")

    X_raw = items_df[feature_cols].fillna(items_df[feature_cols].median())
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_raw)

    elbow_data = None
    noise_count = 0
    labels = None

    if algorithm == "kmeans":
        # Compute Elbow method & Silhouette
        k_list = []
        inertias = []
        silhouettes = []
        for test_k in range(k_min, min(k_max + 1, len(items_df))):
            km = KMeans(n_clusters=test_k, random_state=42, n_init=10)
            preds = km.fit_predict(X_scaled)
            k_list.append(test_k)
            inertias.append(round(float(km.inertia_), 2))
            try:
                sil = silhouette_score(X_scaled, preds) if len(set(preds)) > 1 else 0.0
                silhouettes.append(round(float(sil), 4))
            except Exception:
                silhouettes.append(0.0)

        elbow_data = {"k": k_list, "inertia": inertias, "silhouette": silhouettes}

        # Final K-Means run
        k = min(k, len(items_df) - 1)
        model = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = model.fit_predict(X_scaled)
        n_clusters = k

    elif algorithm == "hierarchical":
        k = min(k, len(items_df) - 1)
        # Limit sample size for agglomerative O(n^2)
        if len(items_df) > 2500:
            items_df = items_df.head(2500)
            X_scaled = X_scaled[:2500]
            warnings.append("Sampled to 2,500 records for Hierarchical clustering performance.")
        model = AgglomerativeClustering(n_clusters=k, linkage=linkage)
        labels = model.fit_predict(X_scaled)
        n_clusters = k

    elif algorithm == "dbscan":
        model = DBSCAN(eps=eps, min_samples=min_samples)
        labels = model.fit_predict(X_scaled)
        unique_labels = set(labels)
        n_clusters = len(unique_labels - {-1})
        noise_count = int((labels == -1).sum())
        if n_clusters == 0:
            warnings.append("DBSCAN marked all points as noise. Try increasing eps or reducing min_samples.")

    # Silhouette score
    try:
        non_noise_mask = (labels != -1)
        if len(set(labels[non_noise_mask])) > 1:
            overall_sil = round(float(silhouette_score(X_scaled[non_noise_mask], labels[non_noise_mask])), 4)
        else:
            overall_sil = 0.0
    except Exception:
        overall_sil = 0.0

    # PCA 2D projection for scatter plot
    pca = PCA(n_components=2, random_state=42)
    coords = pca.fit_transform(X_scaled)
    axes_labels = ["PCA Component 1", "PCA Component 2"]

    groups = []
    unique_clusters = sorted(list(set(labels)))
    for c_id in unique_clusters:
        mask = (labels == c_id)
        pts = [{"x": round(float(coords[i, 0]), 3), "y": round(float(coords[i, 1]), 3)} for i in np.where(mask)[0][:300]]
        lbl = f"Noise (-1)" if c_id == -1 else f"Cluster {c_id}"
        groups.append({"label": lbl, "points": pts})

    # Cluster characteristics / profiles
    items_df["Cluster"] = labels
    summary_cols = ["Cluster", "Item Count"] + [f"Avg {c}" for c in feature_cols]
    summary_rows = []
    interpretation = []

    for c_id in unique_clusters:
        subset = items_df[items_df["Cluster"] == c_id]
        c_lbl = "Noise" if c_id == -1 else f"Cluster {c_id}"
        row = [c_lbl, len(subset)]
        means = []
        for col in feature_cols:
            mean_val = round(float(subset[col].mean()), 2)
            row.append(mean_val)
            means.append((col, mean_val))
        summary_rows.append(row)

        if c_id != -1:
            desc = f"Cluster {c_id} ({len(subset):,} items): Characterized by " + ", ".join([f"{m[0]} ≈ {m[1]}" for m in means])
            interpretation.append(desc)

    # Assignments preview table
    assign_cols = [id_col, "Cluster"] + feature_cols[:3]
    assign_rows = [list(r) for r in items_df[assign_cols].head(50).values]

    return {
        "n_clusters": n_clusters,
        "silhouette": overall_sil,
        "n_items": len(items_df),
        "noise": noise_count if algorithm == "dbscan" else None,
        "elbow": elbow_data,
        "scatter": {"axes": axes_labels, "groups": groups},
        "summary": {"columns": summary_cols, "rows": summary_rows},
        "assignments": {"columns": assign_cols, "rows": assign_rows},
        "interpretation": interpretation,
        "warnings": warnings
    }
