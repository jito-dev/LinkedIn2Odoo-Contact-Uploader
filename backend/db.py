import sqlite3
import json
from contextlib import contextmanager
from typing import List, Optional
from pydantic import BaseModel
import datetime
import os

# --- Pydantic Schema ---
class Campaign(BaseModel):
    """Defines the data structure for a Campaign."""
    id: str
    name: str
    person_tags: List[str]
    company_tags: List[str]
    created_at: str

# --- Database Configuration & Initialization ---
DATA_DIR = "data"
DB_FILE = os.path.join(DATA_DIR, "campaigns.db")

@contextmanager
def get_db_connection():
    """Provides a managed database connection, ensuring it's closed after use."""

    # Ensure the data directory exists before connecting
    os.makedirs(DATA_DIR, exist_ok=True) 

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    """Initializes the database and creates tables if they don't exist."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Create the 'campaigns' table to store campaign details
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS campaigns (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                person_tags TEXT,
                company_tags TEXT,
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()

# --- Campaign CRUD Functions ---
def get_all_campaigns() -> List[Campaign]:
    """Retrieves all campaigns from the database, ordered by creation date."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, person_tags, company_tags, created_at FROM campaigns ORDER BY created_at DESC")
        campaigns = [
            Campaign(
                id=row["id"],
                name=row["name"],
                person_tags=json.loads(row["person_tags"]),
                company_tags=json.loads(row["company_tags"]),
                created_at=row["created_at"]
            ) for row in cursor.fetchall()
        ]
        return campaigns

def upsert_campaign(campaign: Campaign):
    """Creates a new campaign or updates an existing one based on its ID."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO campaigns (id, name, person_tags, company_tags, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                person_tags=excluded.person_tags,
                company_tags=excluded.company_tags
        """, (
            campaign.id,
            campaign.name,
            json.dumps(campaign.person_tags),  # Store lists as JSON strings
            json.dumps(campaign.company_tags),
            campaign.created_at
        ))
        conn.commit()

def remove_campaign(campaign_id: str):
    """Deletes a campaign from the database by its ID."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))
        conn.commit()
