# NeuroFocus

NeuroFocus is a web prototype for remote, one-to-one interviews between an HR user and a candidate. It combines account registration, HR-created room codes, a pre-join device lobby, WebRTC audio/video, chat, screen sharing, interview questions and answers, and a host-side technical event log.

## What is implemented

| Capability | Implementation |
|---|---|
| Accounts | FastAPI registration and login, bcrypt password hashes, HS256 JWT, HR/Candidate roles |
| Account safeguards | Production HR invite code, normalized unique email, password byte limits, per-IP/email failed-login throttling |
| Rooms | HR-generated, server-registered `NF-XXXXXX` code (expires after 12 hours), one HR plus one Candidate per room |
| Interview | Browser WebRTC audio/video with STUN and optional environment-configured TURN; WebSocket signaling |
| Controls | Microphone and camera toggles for both participants; remote media state; leave/cleanup |
| Collaboration | Live chat, HR questions, candidate answers with Python/Java/JavaScript/HTML/CSS/C++ labels, and screen sharing |
| HR event log | Two-second local connection/RTT samples and relayed session events; CSV export; not visible to candidates |
| Storage | SQLite locally; PostgreSQL using `DATABASE_URL` when deployed |

Room membership and WebSocket connections are held in memory by a single application process. Keep the Render service at one instance for this prototype; restarting/redeploying the service ends active rooms. User accounts are stored in the configured database.

## Run locally on Windows

Open PowerShell in the `neurofocus` directory:

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:ENVIRONMENT = "development"
$env:NEUROFOCUS_SECRET = "local-demo-secret-change-this"
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Then open <http://localhost:8000>. The database is created at `backend/neurofocus.db`.

For macOS/Linux, create/activate a virtual environment with `python3 -m venv .venv` and `source .venv/bin/activate`, install the same requirements, set `NEUROFOCUS_SECRET`, and run `uvicorn main:app --reload --host 0.0.0.0 --port 8000` from `backend/`.

## Local two-person smoke test

1. Open two isolated browser sessions (for example, a normal window and a private window) at <http://localhost:8000>.
2. Register one account as **HR** and another as **Candidate**. Use different email addresses and passwords of at least 8 characters.
3. In the HR session, generate a room code and enter the room. Wait at least 15 seconds.
4. In the Candidate session, join with that code. Allow camera and microphone access in both sessions.
5. Confirm both video tiles, try mute/camera controls, send chat both ways, and leave one session. The other should show a peer-left event. Camera and mic states are visible to the other participant.
6. HR can send coding, aptitude, company, or experience questions; candidate answers appear in the question panel. Try screen sharing from either participant and stop it from the browser sharing control or app button.
7. For coding questions, candidates can label answers as Python, Java, JavaScript, HTML, CSS, C++, or other. The server relays answer text and never executes candidate code.
8. The HR session log records technical/session events and two-second connection samples. Once a peer connection is established, it reports whether the selected network path is direct or uses a TURN relay. It does not record call audio/video and does not calculate a trust score or make hiring decisions.
8. For the reverse join order, have the Candidate join first and the HR join second.

This verifies the local application path only. It does not verify mobile data, TURN relay selection, or a deployed service.

## Run automated API/WebSocket checks

From `backend/` with the virtual environment active:

```powershell
python .\smoke_test.py
```

The script uses an isolated temporary SQLite database and checks health/static routes, registration/login/JWT, duplicate and invalid input handling, production secret enforcement, room-code validation, a 15-second delayed join, reverse join order, chat/event/question/answer relay, peer departure, and the room participant limit. These automated checks do not open real cameras or prove WebRTC media or cross-network TURN connectivity.

## Cross-network testing

For users on separate networks (for example, laptop Wi-Fi and phone mobile data), use the deployed **HTTPS** URL. Browsers restrict camera/microphone access to HTTPS or localhost. Configure and verify a TURN service before relying on restrictive networks. The HR quality log labels the selected path as direct or TURN relay once connected:

For a two-laptop test on the same hotspot, do not enter `localhost` on both machines: that name points each browser to its own laptop. The host server must bind to `0.0.0.0`, the candidate must use the host laptop’s LAN address, and the firewall must permit the port. Camera/mic APIs on a remote LAN IP may be blocked because plain HTTP is not a secure browser origin; use a trusted HTTPS deployment or secure tunnel for media testing. A shared hotspot tests one local network path, not internet paths between distant networks.

```text
NEUROFOCUS_TURN_URLS=turn:host:3478,turns:host:5349?transport=tcp
NEUROFOCUS_TURN_USERNAME=<provider username>
NEUROFOCUS_TURN_CREDENTIAL=<provider credential>
```

All three values must be set. Only the username and credential are private; the backend returns ICE server settings to browsers as required by WebRTC. The app reports `turnConfigured: false` if they are absent. STUN-only connectivity can work on some networks, but it is not a cross-network guarantee.

Test with one device on Wi-Fi and another with Wi-Fi turned off on mobile data. In Chrome, open `chrome://webrtc-internals` and inspect the nominated candidate pair. A successful call alone does not prove that TURN was used: look for a `relay` candidate when relay fallback is needed. Record the result, network types, and connection state in your submission notes.

## Deploy to Render

1. Push this project to a Git repository you control and connect that repository in Render.
2. In Render, create a **Blueprint** from the repository root using `render.yaml`. It defines the Python 3.12.11 web service, `/health` check, generated production JWT secret, PostgreSQL database, and unsynced TURN and HR invite settings.
3. In the Render service environment, set a private `NEUROFOCUS_HR_INVITE_CODE` for creating HR accounts, then fill in `NEUROFOCUS_TURN_URLS`, `NEUROFOCUS_TURN_USERNAME`, and `NEUROFOCUS_TURN_CREDENTIAL` from your TURN provider. Keep these values out of Git and screenshots. Candidate registration remains open.
4. Wait for the deploy to finish, then open the generated `https://…onrender.com` URL. Check `/health` returns `{"status":"ok"}` and register fresh HR/Candidate accounts on the deployed site.
5. Repeat the two-session flow against the deployed URL. Then repeat with the second device on mobile data and verify the selected candidate pair in WebRTC internals.

The included Blueprint uses Render's free web service and free PostgreSQL for a student demo. Render documents that free web services have an ephemeral filesystem and free PostgreSQL databases expire after 30 days; upgrade the database before that if account data must be retained. Free services can spin down, so the first page load may be delayed. See [Render free instance limits](https://render.com/docs/free).

No public deployment has been created from this workspace: it requires your Git repository and Render account. A deployed URL, production WebRTC call, and cross-network TURN relay must be verified after you connect those accounts and supply valid TURN credentials.

## Deployment configuration

The backend requires `NEUROFOCUS_SECRET` in production and intentionally stops at startup if it is missing. Locally, a random in-memory secret is generated if you omit it (tokens expire when the process restarts). `DATABASE_URL` selects PostgreSQL or SQLite. See `backend/.env.example` for variable names; do not put real credentials in that example file.

## Submission diagrams and status

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for System Architecture, Data Flow, Use Case, and module/class diagrams matching this source tree. The test table starts with **Not run** statuses; update each row only after performing and recording that test. Never mark cross-network or deployed checks passed based only on localhost behavior.

## Known boundaries

- No computer-vision or machine-learning model is implemented. Camera-derived gaze, drowsiness, or phone-use guesses are not used to score or reject candidates; session events are context only and require human review.
- The host-side event log is held in the HR browser and can be exported as CSV; it is not a server-side audit archive.
- Rooms support exactly one HR and one Candidate, not group calls.
- Active room state is in process memory; use a single app instance.
- TURN must come from credentials you have verified. Provider credentials/availability are outside this repository.
- Coding submissions are text answers labeled by language; they are never executed by this service. Provide a separate sandboxed coding platform if executable assessments are required.
- This is a final-year project prototype, not a production hiring or candidate assessment system.
