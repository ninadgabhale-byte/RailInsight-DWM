"""Association Rule Mining module for RailInsight.
Implements FP-Growth and Apriori algorithms using mlxtend to discover co-occurrence
patterns in railway ticket configurations (Ticket Type, Booking Mode, Payment Channel, Railway Line).
"""
import time
import pandas as pd
from mlxtend.frequent_patterns import apriori, fpgrowth, association_rules

def run_association_mining(df: pd.DataFrame, req: dict):
    algorithm = req.get("algorithm", "fpgrowth")
    columns = req.get("columns", [])
    min_support = float(req.get("min_support", 0.05))
    min_confidence = float(req.get("min_confidence", 0.3))
    min_lift = float(req.get("min_lift", 1.0))
    max_len = int(req.get("max_len", 3))

    if not columns or len(columns) < 2:
        raise ValueError("Select at least two categorical attributes to build itemsets.")

    valid_cols = [c for c in columns if c in df.columns]
    if len(valid_cols) < 2:
        raise ValueError("At least two selected columns must exist in the dataset.")

    # Limit transaction sample for performance if dataset is massive
    sample_df = df[valid_cols].dropna().head(40000).copy()
    for c in valid_cols:
        sample_df[c] = c + "=" + sample_df[c].astype(str)

    # Convert to one-hot boolean transactions
    basket_df = pd.get_dummies(sample_df, dtype=bool)

    runtimes = {}
    frequent_itemsets = None
    warnings = []

    # 1. Run algorithm
    if algorithm in ["fpgrowth", "both"]:
        t0 = time.time()
        frequent_itemsets_fp = fpgrowth(basket_df, min_support=min_support, use_colnames=True, max_len=max_len)
        runtimes["FP-Growth"] = round(time.time() - t0, 3)
        frequent_itemsets = frequent_itemsets_fp

    if algorithm in ["apriori", "both"]:
        t0 = time.time()
        frequent_itemsets_ap = apriori(basket_df, min_support=min_support, use_colnames=True, max_len=max_len)
        runtimes["Apriori"] = round(time.time() - t0, 3)
        if frequent_itemsets is None:
            frequent_itemsets = frequent_itemsets_ap

    if frequent_itemsets is None or frequent_itemsets.empty:
        warnings.append("No frequent itemsets found with the specified minimum support. Try reducing minimum support.")
        return {
            "transactions": len(basket_df),
            "runtimes": runtimes,
            "itemsets": {"columns": ["Itemset", "Support", "Length"], "rows": []},
            "rules": {"columns": ["Antecedents", "Consequents", "support", "confidence", "lift"], "rows": []},
            "warnings": warnings
        }

    # Format frequent itemsets
    frequent_itemsets["length"] = frequent_itemsets["itemsets"].apply(len)
    itemsets_sorted = frequent_itemsets.sort_values(by="support", ascending=False).head(100)
    itemsets_rows = []
    for _, r in itemsets_sorted.iterrows():
        items_str = ", ".join(sorted(list(r["itemsets"])))
        itemsets_rows.append([items_str, round(float(r["support"]), 4), int(r["length"])])

    # 2. Generate Association Rules
    rules_rows = []
    try:
        rules_df = association_rules(frequent_itemsets, metric="confidence", min_threshold=min_confidence)
        if not rules_df.empty and min_lift > 0:
            rules_df = rules_df[rules_df["lift"] >= min_lift]
        
        if not rules_df.empty:
            rules_df = rules_df.sort_values(by=["lift", "confidence"], ascending=False).head(100)
            for _, r in rules_df.iterrows():
                ant = ", ".join(sorted(list(r["antecedents"])))
                con = ", ".join(sorted(list(r["consequents"])))
                rules_rows.append([
                    ant,
                    con,
                    round(float(r["support"]), 4),
                    round(float(r["confidence"]), 4),
                    round(float(r["lift"]), 4)
                ])
        else:
            warnings.append("No association rules met the minimum confidence and lift thresholds.")
    except Exception as ex:
        warnings.append(f"Association rule generation note: {str(ex)}")

    return {
        "transactions": len(basket_df),
        "runtimes": runtimes,
        "itemsets": {"columns": ["Itemset", "Support", "Length"], "rows": itemsets_rows},
        "rules": {"columns": ["Antecedents", "Consequents", "support", "confidence", "lift"], "rows": rules_rows},
        "warnings": warnings
    }
