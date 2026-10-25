"""Configuration module for RailInsight Railway Analytics System.
Supports MySQL connection with automatic graceful SQLite fallback.
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# Base directories
BASE_DIR = Path(__file__).resolve().parent.parent
DOCS_DIR = BASE_DIR / "docs"
DATASETS_DIR = BASE_DIR / "datasets"
RAW_DATA_DIR = DATASETS_DIR / "raw"
PROCESSED_DATA_DIR = DATASETS_DIR / "processed"
UPLOADS_DIR = BASE_DIR / "uploads"
REPORTS_DIR = BASE_DIR / "reports"

for d in [DOCS_DIR, RAW_DATA_DIR, PROCESSED_DATA_DIR, UPLOADS_DIR, REPORTS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Load environment variables
load_dotenv(BASE_DIR / ".env")

FLASK_ENV = os.getenv("FLASK_ENV", "development")
FLASK_PORT = int(os.getenv("FLASK_PORT", 5000))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", 200))
SECRET_KEY = os.getenv("SECRET_KEY", "railinsight-dwm-secret-key-2026")

# Database configuration
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "3306")
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "railinsight_dw")

# SQLite fallback path
SQLITE_PATH = BASE_DIR / "database" / "railinsight_dw.db"
SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)

_db_engine = None
_db_type = "none"

def get_db_engine():
    """Return an active SQLAlchemy database engine.
    Tries MySQL first; falls back to local SQLite if MySQL server is offline.
    """
    global _db_engine, _db_type
    if _db_engine is not None:
        return _db_engine, _db_type

    # Attempt MySQL connection
    if DB_USER and DB_NAME:
        try:
            pwd_part = f":{DB_PASSWORD}" if DB_PASSWORD else ""
            mysql_uri = f"mysql+mysqlconnector://{DB_USER}{pwd_part}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
            engine = create_engine(mysql_uri, pool_pre_ping=True, pool_recycle=3600)
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            _db_engine = engine
            _db_type = "mysql"
            return _db_engine, _db_type
        except Exception as e:
            # MySQL unavailable, fall back to SQLite
            pass

    sqlite_uri = f"sqlite:///{SQLITE_PATH}"
    _db_engine = create_engine(sqlite_uri, pool_pre_ping=True)
    _db_type = "sqlite"
    return _db_engine, _db_type

def is_db_connected():
    try:
        engine, _ = get_db_engine()
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
