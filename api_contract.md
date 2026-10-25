# RailInsight – API contract (frontend ⇄ Flask backend)

Base URL `http://127.0.0.1:5000`. All responses are JSON unless stated. Success returns the payload directly.
Errors return `{ "error": "human readable message" }` with a proper status code:
`400` bad input · `404` not found · `409` precondition missing (e.g. no dataset, ETL not run) · `413` file too large · `500` server error.
Enable CORS for the frontend origin and `expose_headers=["Content-Disposition"]`.
Rows in tables are **arrays aligned with `columns`**. Chart specs follow `frontend/js/charts.js`.

| Method & path | Request | Response (key fields) |
|---|---|---|
| GET `/api/health` | – | `status, dataset_loaded, database_connected` |
| POST `/api/upload` | multipart `file` (.csv only) | `filename, rows, columns` |
| GET `/api/dataset/summary` | – | `file_name, rows, columns, duplicates, missing_cells, memory_mb, notes[], columns_info[{column,dtype,kind,missing,missing_pct,unique,suggested_role}], describe{columns,rows}` (409 if no dataset) |
| GET `/api/dataset/preview?n=15` | – | `columns, rows` |
| GET/POST `/api/dataset/mapping` | POST `{mapping:{role:column}}` | GET: `columns[], roles[{key,label,description,required,mapped}]` |
| POST `/api/dataset/validate` | – | `valid, checks[{name,status:pass|warn|fail,message}], available_features[{feature,available,requires[]}]` |
| GET `/api/dataset/download?stage=raw|processed` | – | CSV file |
| GET `/api/analytics/dashboard?from&to&station` | – | `filters{date_range{min,max},stations[]}, kpis[{key,label,value,format,hint}], charts[], unavailable[{feature,requires[]}]` |
| GET `/api/analytics/<booking|revenue|route|station|time|ticket>` | – | `charts[], unavailable[]` |
| POST `/api/preprocessing/run` | `{category, operation, params}` | `message, warnings[], stats{}, before{columns,rows,title}, after{...}, charts[], changed` |
| POST `/api/preprocessing/integrate/analyze` | multipart `file` | `filename, rows, columns[], existing_columns[], suggested_mapping{incoming:existing|null}` |
| GET `/api/preprocessing/compare` | – | `raw{rows,columns,missing_cells,duplicates}, processed{...}, columns_added[], columns_removed[], history[]` |
| POST `/api/preprocessing/reset` | – | `{ok:true}` |
| POST `/api/etl/run` | `{source:csv|mysql|extra, mode:incremental|full, table?}` | `202 {state:"running"}` (background job) |
| GET `/api/etl/status` | – | `state:idle|running|success|failed, stages[{key,status:pending|running|success|failed,duration_ms,message}], metrics{extracted,valid,rejected,transformed,loaded,skipped_existing,duration_sec}, logs[{ts,level,message}], rejected{columns,rows}` |
| GET `/api/etl/tables` · POST `/api/etl/upload-extra` · GET `/api/etl/rejected` | – / multipart / – | `tables[]` · `rows` · CSV |
| GET `/api/warehouse/schema` | – | `grain, tables[{name,kind,rows,columns[{name,type,key,references}]}], ddl, indexes[{table,columns,reason,ddl}], sample_queries[{id,title,sql,explanation}]` |
| POST `/api/warehouse/sample/run` | `{id}` | `columns, rows` (only whitelisted stored queries) |
| GET `/api/olap/metadata` | – | `dimensions[{key,label,time?,values?[]}], time_levels[{key,label}], measures[{key,label}], aggregations[]` |
| POST `/api/olap/query` | `{operation:rollup|drilldown|slice|dice|pivot, measure, agg, level?, path?[{level,value}], slice?{dimension,value}, dice?[{dimension,values[]}], group_by?, pivot?{rows,columns}, limit}` | `sql, params, columns, rows, chart, level, next_level, row_count, truncated?` |
| GET `/api/mining/options` | – | `notes[], classification{targets[{column,label,note,excluded_features[]}],features[{column,kind}],note}, clustering{entities[{key,label,description,supported}]}, association{transaction_columns[],note}, anomaly{units[{key,label,description,supported,reason}]}` |
| POST `/api/mining/classification` | `{target,features[],algorithms[],test_size,sample_size,random_state}` | `split{train,test}, classes[], baseline{majority_accuracy}, results[{algorithm,accuracy,precision,recall,f1,train_seconds,confusion{labels,matrix},report[{label,precision,recall,f1,support}],feature_importance?}], warnings[]` |
| POST `/api/mining/clustering` | `{entity,algorithm,k,k_min,k_max,linkage,eps,min_samples,sample_size}` | `n_clusters, silhouette, n_items, noise?, elbow?{k[],inertia[],silhouette[]}, scatter{axes[],groups[{label,points[{x,y}]}]}, summary{columns,rows}, assignments{columns,rows}, interpretation[], warnings[]` |
| POST `/api/mining/association` | `{algorithm,columns[],min_support,min_confidence,min_lift,max_len}` | `transactions, runtimes{}, itemsets{columns,rows}, rules{columns:[...,"support","confidence","lift"],rows}, warnings[]` |
| POST `/api/mining/anomaly` | `{unit,method,contamination,iqr_k}` | `summary{total,flagged}, anomalies{columns,rows}, chart?, boxplot?[{label,min,q1,median,q3,max}], warnings[]` |
| GET `/api/mining/patterns` | – | `patterns[{category,title,finding}], charts[], warnings[]` |
| GET `/api/forecast/options` | – | `targets[{key,label,available,reason}], granularities[], models[{key,label}], max_horizon` |
| POST `/api/forecast` | `{target,granularity,model,horizon,test_fraction}` | `available, reason?, history{labels,values}, test{labels,predicted}, forecast{labels,values,lower?,upper?}, metrics{MAE,RMSE,R2,baseline_MAE}, split{train_end}, unit?, warnings[]` |
| GET `/api/reports/list` | – | `reports[{key,title,description,available,reason}]` keys: dataset, preprocessing, etl, warehouse, olap, classification, clustering, association, analytics, forecasting |
| GET `/api/reports/preview?type=` | – | `title, sections[{heading,text?,bullets?[],table?{columns,rows}}]` (409 if module not run) |
| GET `/api/reports/export?type=&format=csv|excel|pdf` | – | file download (409 JSON error if module not run) |

## Rules the backend must follow
1. Never invent data: if a column is missing, omit the KPI/chart and add it to `unavailable` with `requires`.
2. Never execute SQL sent by the browser. OLAP keys are mapped through a whitelist and values are bound parameters.
3. Classification: drop leakage columns and report the majority-class baseline.
4. Forecasting: chronological split; return `available:false` + `reason` when history is too short.
5. Long jobs (ETL) run in a background thread; `/api/etl/status` is polled once per second.
