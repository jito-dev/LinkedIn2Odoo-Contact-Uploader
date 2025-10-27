# LinkedIn to Odoo Contact Uploader

A Chrome Extension and backend service designed to scrape LinkedIn profiles and create or update contacts in Odoo with a single click. Includes a campaign management system to automatically tag new contacts.

https://github.com/user-attachments/assets/523fa889-7417-43d0-b1f4-5d8878593435

## Features

- **One-Click Contact Creation:** A floating button is injected directly onto LinkedIn profile pages to create or update an Odoo contact instantly.

- **Detailed Popup Form:** An extension popup allows you to review, edit, and add information (like tags and notes) before uploading a contact.

- **Smart Contact/Company Handling:** Automatically finds or creates both the person and their company in Odoo, linking them correctly (res.partner models).

- **Duplicate Checking:** Checks Odoo for an existing contact by name or email before creating a new one.

- **Campaign Management:** A full-featured campaign manager in the extension's options page. Create campaigns with predefined "Person" and "Company" tags.

- **Automatic Tagging:** Set an "active campaign" to automatically apply its tags to all new contacts, streamlining your lead generation.

- **Secure Credential Storage:** Odoo connection details (URL, DB, Login, API Token) are stored securely in the extension's local storage.

- **Dockerized Backend:** The entire backend is containerized with Docker for easy development and production deployment.

## How It Works

The project is split into two main components:

1. **Frontend (Chrome Extension)**:

   - `content.js` scrapes the LinkedIn profile DOM and injects the floating "quick-create" button.

   - `popup.js` manages the detailed form for reviewing scraped data.

   - `options.js` & `campaigns.js` handle saving Odoo credentials and managing campaigns.

   - All frontend components communicate with the backend API.

2. **Backend (FastAPI Server)**:

   - Provides API endpoints to handle requests from the extension.

   - `main.py` contains all logic for connecting to Odoo via XML-RPC, finding/creating tags, and creating/updating contacts and companies.

   - `db.py` uses a local SQLite database to store and manage campaign data (names and associated tags).

### Basic Workflow:
1. User configures Odoo credentials in the extension's Options page.

2. User browses to a LinkedIn profile.

3. `content.js` (or `popup.js`) scrapes the profile data.

4. User clicks "Upload" (either via the popup or the floating button).

5. The extension sends the scraped data to the FastAPI backend.

6. The backend fetches the active campaign tags from its SQLite DB.

7. The backend connects to Odoo via XML-RPC, finds/creates the company, and then finds/creates the person, applying all data and tags.

8. A success message is returned to the user.

## Tech Stack

- **Frontend:** JavaScript (ES Modules), HTML5, CSS3

- **Backend**: Python 3.10, FastAPI, SQLite

- **Odoo Integration:** XML-RPC

- **DevOps:** Docker, Docker Compose

## Setup and Installation

### Prerequisites

- **Git**

- **Docker & Docker Compose**

- A **Google Chrome**-based browser

- An **Odoo** instance (v12+) with XML-RPC enabled and an API Key for your user.

### 1. Backend Setup

First, clone the repository:

    git clone https://github.com/alextranduil/linkedin2odoo-contact-uploader.git
Go to the directory:

    cd linkedin2odoo-contact-uploader


Next, you must create an environment file. The backend service will not run without it.

1. Create a file named .env in the root of the project:

        touch .env

2. Open the .env file and add the following line:

        # This ID is temporary for local development.
        CHROME_EXTENSION_ORIGIN="chrome-extension://YOUR_LOCAL_EXTENSION_ID"
    _You will get this ID in the next step._

### 2. Frontend (Chrome Extension) Setup

1. Open Google Chrome and navigate to `chrome://extensions`.

2. Enable **"Developer mode"** in the top-right corner.

3. Click **"Load unpacked"**.

4. Select the `frontend` folder from this repository.

5. The extension will load. **Find its new ID card and copy the ID**.
_Example:_ `ID: ngbamfdfnpelmkknbakjfnmdmgelpemh`

6. Paste this ID into your `.env` file:

        CHROME_EXTENSION_ORIGIN="chrome-extension://ngbamfdfnpelmkknbakjfnmdmgelpemh"

### 3. Run the Application

Now you can run the backend server using Docker Compose.

- **For Local Development (with hot-reloading)**:

      docker-compose -f docker-compose-local.yml up --build


    Your backend is now running at `ttp://127.0.0.1:8000`.

- **For Production Deployment**: _See the Deployment section below._

## Configuration & Usage

### 1. Configure Odoo Connection

1. Right-click the extension icon in your Chrome toolbar and click "Options".

2. Fill in your Odoo instance details:

    - **Odoo Base URL:** `https://your-odoo.example.com`
    - **Database:** Your Odoo database name
    - **Login:** Your Odoo username
    - **API Token:** Your Odoo user's API Key (found in Odoo under _User > Preferences > Account Security_)

Click **"Test Connection"**. If successful, click **"Save Credentials"**.

### 2. Manage Campaigns (Optional)

1. In the Options page, go to the **"Campaigns"** section.

2. Create a new campaign (e.g., "Q4 Tech Leads").

3. Add tags you want applied to **people** (e.g., "Lead", "Developer") and **companies** (e.g., "SaaS", "B2B").

4. Use the **"Set Current Campaign"** dropdown to make your new campaign active.

### 3. Upload Contacts

You now have two ways to upload contacts:

- **Method 1: Quick-Create Button**

    1. Navigate to a LinkedIn profile (e.g., `linkedin.com/in/some-user`).

    2. A floating button `➕ Create Contact` will appear in the bottom-left.

    3. Click it. The extension will scrape the profile, apply your active campaign tags, and create/update the contact in Odoo.

    4. The button will change to `🔁 Update Contact` if the contact already exists.

- **Method 2: Extension Popup**

    1. Navigate to a LinkedIn profile.
    2. Click the extension icon in your Chrome toolbar.
    3. The popup will open, pre-filled with scraped data.
    4. You can review, edit, and manually add/remove tags.
    5. Click **"Upload Contact to Odoo"**.

## Deployment (Production)

This project is designed to be deployed on a server using Docker.

1. Ensure your server has `git`, `docker`, and `docker-compose`.

2. Clone the repository.

3. Create a production `.env` file. This file must contain the final, published ID of your extension from the Chrome Web Store.

       # .env
       CHROME_EXTENSION_ORIGIN="chrome-extension://YOUR_PRODUCTION_ID_FROM_WEB_STORE"

4. Use the provided deployment scripts:

    - **To build and start the server**:

            ./deploy-prod.sh
      _(This runs `docker-compose -f docker-compose-prod.yml up --build -d`)_

    - **To stop the server**:

            ./stop-prod.sh
      _(This runs `docker-compose -f docker-compose-prod.yml down`)_

    - **To pull updates from Git and restart**:

            ./pull-stop-start.sh
      _(This runs `git pull`, stops, and restarts the server)_

