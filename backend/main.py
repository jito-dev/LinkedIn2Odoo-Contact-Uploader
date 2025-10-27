import xmlrpc.client as xmlrpc
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl
import requests
import base64
import logging
from typing import Optional, List
from starlette.middleware.cors import CORSMiddleware
import uuid
import datetime
from dotenv import load_dotenv
import os
from . import db # Import the local database module

# --- Configuration and Setup ---

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
try:
    load_dotenv()
    # Read the comma-separated list of origins
    chrome_origins_str = os.environ.get("CHROME_EXTENSION_ORIGIN", "")
except Exception as e:
    logger.error(f"Failed to load environment variables: {e}")

# Initialize FastAPI application
app = FastAPI(
    title="LinkedIn to Odoo Backend",
    description="API to handle contact creation and campaign management."
)

# Initialize the SQLite database on application startup
db.init_db()

# Define allowed origins for CORS (Cross-Origin Resource Sharing)
allowed_origins = [
    "https://www.linkedin.com", # LinkedIn for the content script
]

# Add multiple extension origins from the .env variable
if chrome_origins_str:
    # Split the string by commas and add each one to the list
    for origin in chrome_origins_str.split(','):
        stripped_origin = origin.strip()
        if stripped_origin:
            allowed_origins.append(stripped_origin)
    logger.info(f"Configured allowed origins: {allowed_origins}")
else:
    logger.warning("CHROME_EXTENSION_ORIGIN environment variable is not set. Chrome extension requests may be blocked by CORS policy.")


# Configure CORS middleware    
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Odoo Client Helper Function ---
def get_odoo_client(url: str, database: str, username: str, api_token: str = ""):
    """
    Attempts to authenticate with the Odoo XML-RPC API.
    Returns the models proxy, user ID (uid), and a status message.
    """
    try:
        url = str(url).rstrip('/') + '/'
        common = xmlrpc.ServerProxy(f"{url}xmlrpc/2/common")
        uid = common.authenticate(database, username, api_token, {})
        if uid:
            models = xmlrpc.ServerProxy(f"{url}xmlrpc/2/object")
            return models, uid, "Connected successfully"
        return None, None, "Authentication failed"
    except Exception as e:
        logger.error(f"Odoo Connection Error: {e}")
        return None, None, f"Server connection failed: {e}"

# --- Pydantic Schemas ---
class OdooCredentials(BaseModel):
    """Schema for basic Odoo connection credentials."""
    odoo_server: HttpUrl
    odoo_db_name: str 
    username: str
    api_token: str

class ContactCheckPayload(OdooCredentials):
    """Schema for checking if a contact exists, extending credentials."""
    name: Optional[str] = None
    email: Optional[str] = None
    
class ContactPayload(OdooCredentials):
    """Schema for creating/updating a contact, extending credentials."""
    name: str
    company: Optional[str] = None
    job_position: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    city: Optional[str] = None 
    tags: Optional[str] = None # Comma-separated string
    photo: Optional[str] = None # URL
    additional_info: Optional[str] = None
    contact_type: str # e.g., "individual"
    company_photo: Optional[str] = None # URL
    company_linkedin_url: Optional[str] = None
    company_tags: Optional[str] = None # Comma-separated string
    company_additional_info: Optional[str] = None

class CampaignCreate(BaseModel):
    """Schema for creating or updating a campaign."""
    name: str
    person_tags: List[str]
    company_tags: List[str]

# --- Utility Functions ---
def download_image_as_base64(url: Optional[str]) -> Optional[str]:
    """Downloads an image from a URL and returns it as a base64 encoded string."""
    if not url: return None
    try:
        # Add a user-agent to mimic a browser, as LinkedIn may block default request agents
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        r = requests.get(url, timeout=10, headers=headers)
        r.raise_for_status()
        return base64.b64encode(r.content).decode('utf-8')
    except requests.exceptions.RequestException as e:
        logger.warning(f"Failed to download image from {url}: {e}")
        return None

def find_or_create_tags_odoo(odoo, uid, db_name, api_token, tag_names_str: Optional[str]) -> List[int]:
    """
    Finds existing Odoo partner tags ('res.partner.category') or creates new ones.
    Returns a list of tag IDs.
    """
    if not tag_names_str: return []
    tag_ids = []
    # Ensure tags are unique
    tag_names = list(set([t.strip() for t in tag_names_str.split(',') if t.strip()]))
    
    if not tag_names: return []

    for tag_name in tag_names:
        try:
            # Search for the tag by name
            domain = [['name', '=', tag_name]]
            ids = odoo.execute_kw(
                db_name, uid, api_token, 
                'res.partner.category', 'search', 
                [domain], # Domain list in args list
                {'limit': 1} # Kwargs dictionary
            )
            
            if ids:
                tag_ids.append(ids[0])
            else:
                # Create the tag if it doesn't exist
                new_id = odoo.execute_kw(db_name, uid, api_token, 'res.partner.category', 'create', [{'name': tag_name}])
                tag_ids.append(new_id)
        except Exception as e:
            logger.error(f"Error finding/creating tag '{tag_name}': {e}")
            # If it's a Fault, raise it to be caught by the main endpoint handler
            if isinstance(e, xmlrpc.Fault):
                raise e 
            # Otherwise, just log and continue (maybe a transient issue)
    return tag_ids

# --- FastAPI Endpoints ---

@app.post("/test_connection")
async def test_odoo_connection(credentials: OdooCredentials):
    """Endpoint to validate Odoo connection credentials."""
    _, uid, message = get_odoo_client(str(credentials.odoo_server), credentials.odoo_db_name, credentials.username, credentials.api_token)
    if uid:
        return {"status": "success", "message": message, "uid": uid}
    raise HTTPException(status_code=401, detail=message)

@app.post("/check_contact")
async def check_contact_exists(payload: ContactCheckPayload):
    """Checks if an individual contact exists in Odoo by name or email."""
    models, uid, msg = get_odoo_client(str(payload.odoo_server), payload.odoo_db_name, payload.username, payload.api_token)
    if not uid:
        raise HTTPException(status_code=401, detail=msg)
    
    domain_parts = []
    if payload.name:
        domain_parts.append(['name', '=', payload.name.strip()])
    if payload.email:
        domain_parts.append(['email', '=', payload.email.strip()])
    
    if not domain_parts:
        return {"exists": False, "id": None}
        
    c_domain = ['is_company', '=', False]
    
    if len(domain_parts) > 1:
        # Create an OR domain for name/email: ['|', A, B]
        or_domain = ['|'] * (len(domain_parts) - 1) + domain_parts
        # Combine with AND: ['&', or_domain, c_domain] 
        final_domain = ['&'] + or_domain + [c_domain]
    else:
        # Just one part: ['&', A, C]
        final_domain = ['&', domain_parts[0], c_domain]

    try:
        existing_ids = models.execute_kw(
            payload.odoo_db_name, uid, payload.api_token, 
            'res.partner', 'search', 
            [final_domain],  # Domain must be wrapped in a list for the 'args' param
            {'limit': 1}     # Use kwargs dictionary for limit
        )
        
        if existing_ids:
            return {"exists": True, "id": existing_ids[0]}
        return {"exists": False, "id": None}
    except Exception as e:
        logger.error(f"Error checking contact: {e}")
        if isinstance(e, xmlrpc.Fault):
            raise HTTPException(status_code=500, detail=f"Odoo Error: {e.faultString}")
        raise HTTPException(status_code=500, detail=f"Error checking contact: {e}")


@app.post("/create_contact")
async def create_contact_endpoint(payload: ContactPayload):
    """
    Creates or updates a contact (and its parent company) in Odoo.
    It finds/creates the company first, then finds/creates the individual contact.
    """
    models, uid, msg = get_odoo_client(str(payload.odoo_server), payload.odoo_db_name, payload.username, payload.api_token)
    if not uid: raise HTTPException(status_code=401, detail=msg)
    
    odoo, db_name, api_token = models, payload.odoo_db_name, payload.api_token
    company_id = None
    
    try:
        # 1. Find or Create Company
        if payload.company:
            name = payload.company.strip()
            # Search for company by name (case-insensitive)
            domain = [['is_company', '=', True], ['name', '=ilike', name]]
            ids = odoo.execute_kw(
                db_name, uid, api_token, 
                'res.partner', 'search', 
                [domain], # Domain list in args list
                {'limit': 1} # Use kwargs dict for limit
            )
            
            # Prepare data that is common to both create and update
            common_data = {
                'name': name, 
                'is_company': True,
            }
            if payload.company_linkedin_url is not None:
                common_data['website'] = str(payload.company_linkedin_url)
            if payload.company_additional_info is not None:
                common_data['comment'] = payload.company_additional_info
            if img := download_image_as_base64(payload.company_photo): 
                common_data['image_1920'] = img
            if tags := find_or_create_tags_odoo(odoo, uid, db_name, api_token, payload.company_tags): 
                common_data['category_id'] = [(6, 0, tags)] # (6, 0, [IDs]) replaces tags
                
            if ids:
                company_id = ids[0]
                # Company exists. ONLY write common_data.
                # We do not write 'city' here, as this propagates to 
                # child contacts and erases their location.
                odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'write', [[company_id], common_data])
            else:
                # Company is new. Add 'city': False to the create payload
                # to ensure it's created without a location.
                create_data = common_data.copy()
                create_data['city'] = False 
                
                # Create new company
                company_id = odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'create', [create_data])

        # 2. Find or Create Person
        name = payload.name.strip()
        
        domain_parts = []
        if payload.name:
            domain_parts.append(['name', '=', name])
        if payload.email:
            domain_parts.append(['email', '=', payload.email])
        
        ids = [] # Default to no IDs found
        final_domain = [] # Default to empty domain
        
        if domain_parts:
            c_domain = ['is_company', '=', False]
            
            if len(domain_parts) > 1:
                or_parts = ['|'] * (len(domain_parts) - 1) + domain_parts
                final_domain = ['&'] + or_parts + [c_domain]
            else:
                final_domain = ['&', domain_parts[0], c_domain]
            
            # Search for existing person
            ids = odoo.execute_kw(
                db_name, uid, api_token, 
                'res.partner', 'search', 
                [final_domain], # Domain list in args list
                {'limit': 1} # Use kwargs dict for limit
            )

        # Prepare person data
        data = {
            'name': name, 
            'is_company': False,
        }
        
        # Conditionally add fields only if they are not None
        if payload.job_position is not None:
            data['function'] = payload.job_position
        if payload.email is not None:
            data['email'] = payload.email
        if payload.phone is not None:
            data['phone'] = payload.phone
        if payload.website is not None:
            data['website'] = str(payload.website)
        
        # Here, payload.city IS added to the person's 'data' dict.
        if payload.city is not None:
            data['city'] = payload.city
            
        if payload.additional_info is not None:
            data['comment'] = payload.additional_info
        
        # Set 'parent-id' in a separate 'write' call (see below)
        # to avoid Odoo's onchange logic overwriting the city.
        
        if img := download_image_as_base64(payload.photo): data['image_1920'] = img
        if tags := find_or_create_tags_odoo(odoo, uid, db_name, api_token, payload.tags): 
            data['category_id'] = [(6, 0, tags)]

        if ids:
            person_id = ids[0]
            # Update existing person (Step 1: update details)
            odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'write', [[person_id], data])
            # (Step 2: update parent)
            if company_id:
                odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'write', [[person_id], {'parent_id': company_id}])
        else:
            # Create new person (Step 1: create with details)
            person_id = odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'create', [data])
            # (Step 2: update parent)
            if company_id:
                odoo.execute_kw(db_name, uid, api_token, 'res.partner', 'write', [[person_id], {'parent_id': company_id}])
        
        return {"status": "success", "person_id": person_id, "company_id": company_id}

    except Exception as e:
        logger.error(f"Error in create_contact_endpoint: {e}")
        # Check if e is an XML-RPC Fault and extract the Odoo-side error
        if isinstance(e, xmlrpc.Fault):
            raise HTTPException(status_code=500, detail=f"Odoo Error: {e.faultString}")
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {e}")


# --- Campaign Endpoints (using SQLite) ---
@app.post("/campaigns", response_model=db.Campaign)
def create_campaign_endpoint(campaign_data: CampaignCreate):
    """Creates a new campaign in the local SQLite database."""
    # Ensure tags are unique
    person_tags = list(set(campaign_data.person_tags))
    company_tags = list(set(campaign_data.company_tags))

    new_campaign = db.Campaign(
        id=str(uuid.uuid4()),
        name=campaign_data.name,
        person_tags=person_tags,
        company_tags=company_tags,
        created_at=datetime.datetime.utcnow().isoformat()
    )
    db.upsert_campaign(new_campaign)
    return new_campaign

@app.get("/campaigns", response_model=List[db.Campaign])
def read_campaigns_endpoint():
    """Retrieves all campaigns from the local SQLite database."""
    return db.get_all_campaigns()

@app.put("/campaigns/{campaign_id}", response_model=db.Campaign)
def update_campaign_endpoint(campaign_id: str, campaign_data: CampaignCreate):
    """Updates an existing campaign in the local SQLite database by its ID."""
    all_campaigns = db.get_all_campaigns()
    existing_campaign = next((c for c in all_campaigns if c.id == campaign_id), None)
    if not existing_campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Ensure tags are unique
    person_tags = list(set(campaign_data.person_tags))
    company_tags = list(set(campaign_data.company_tags))

    updated_campaign = db.Campaign(
        id=campaign_id,
        name=campaign_data.name,
        person_tags=person_tags,
        company_tags=company_tags,
        created_at=existing_campaign.created_at # Preserve original creation date
    )
    db.upsert_campaign(updated_campaign)
    return updated_campaign

@app.delete("/campaigns/{campaign_id}")
def delete_campaign_endpoint(campaign_id: str):
    """Deletes a campaign from the local SQLite database by its ID."""
    db.remove_campaign(campaign_id)
    return {"status": "success", "campaign_id": campaign_id}

