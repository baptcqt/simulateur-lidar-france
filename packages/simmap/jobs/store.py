from pathlib import Path
import sqlite3

def migrate(path: Path):
 path.parent.mkdir(parents=True,exist_ok=True); c=sqlite3.connect(path); c.execute('CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,name TEXT UNIQUE,path TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)'); c.execute('CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,project TEXT,status TEXT,kind TEXT,progress REAL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP)'); c.commit(); c.close()
