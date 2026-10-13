"""NeuroFocus API, authentication, and single-process interview signaling."""
import datetime
import hmac
import json
import os
import re
import secrets
import time
from typing import Dict, List, Optional

import bcrypt
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import Column, Integer, String, create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
IS_PRODUCTION = os.getenv("ENVIRONMENT", "").lower() == "production" or bool(os.getenv("RENDER"))
SECRET_KEY = os.getenv("NEUROFOCUS_SECRET")
if not SECRET_KEY and IS_PRODUCTION:
    raise RuntimeError("NEUROFOCUS_SECRET must be configured in production")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(32)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///" + os.path.join(BASE_DIR, "neurofocus.db"))
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite:") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(80), nullable=False)
    email = Column(String(254), unique=True, index=True, nullable=False)
    password_hash = Column(String(100), nullable=False)
    role = Column(String(16), nullable=False)


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: str
    hr_invite_code: Optional[str] = Field(default=None, max_length=128)

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, value):
        if not isinstance(value, str):
            raise ValueError("Name must be text")
        value = value.strip()
        if not value:
            raise ValueError("Name is required")
        return value

    @field_validator("email", mode="before")
    @classmethod
    def clean_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("role")
    @classmethod
    def valid_role(cls, value):
        value = value.lower()
        if value not in ("hr", "candidate"):
            raise ValueError("Role must be HR or Candidate")
        return value

    @field_validator("password")
    @classmethod
    def bcrypt_byte_limit(cls, value):
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)

    @field_validator("email", mode="before")
    @classmethod
    def clean_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("password")
    @classmethod
    def bcrypt_byte_limit(cls, value):
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value


class AuthResponse(BaseModel):
    token: str
    name: str
    role: str
    email: str


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_token(user: User) -> str:
    payload = {
        "sub": str(user.id), "name": user.name, "role": user.role, "email": user.email,
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=12),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def decode_token(token: str) -> dict:
    try:
        claims = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        if claims.get("role") not in ("hr", "candidate"):
            raise jwt.InvalidTokenError("Invalid role")
        return claims
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return decode_token(authorization.split(" ", 1)[1])


app = FastAPI(title="NeuroFocus API", version="1.0.0")


@app.middleware("http")
async def prevent_stale_frontend(request, call_next):
    if request.url.path.endswith((".html", ".css", ".js")):
        request.scope["headers"] = [
            (key, value)
            for key, value in request.scope["headers"]
            if key.lower() not in (b"if-none-match", b"if-modified-since")
        ]
    response = await call_next(request)
    if request.url.path.endswith((".html", ".css", ".js")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/register", response_model=AuthResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    if IS_PRODUCTION and req.role == "hr":
        expected_code = os.getenv("NEUROFOCUS_HR_INVITE_CODE", "")
        if not expected_code:
            raise HTTPException(status_code=503, detail="HR registration is not configured. Contact the site administrator.")
        if not req.hr_invite_code or not hmac.compare_digest(req.hr_invite_code, expected_code):
            raise HTTPException(status_code=403, detail="A valid HR invite code is required")
    user = User(name=req.name, email=str(req.email), password_hash=hash_password(req.password), role=req.role)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email already registered")
    db.refresh(user)
    return AuthResponse(token=create_token(user), name=user.name, role=user.role, email=user.email)


LOGIN_FAILURES: Dict[str, List[datetime.datetime]] = {}
LOGIN_WINDOW = datetime.timedelta(minutes=15)
LOGIN_FAILURE_LIMIT = 8


@app.post("/api/login", response_model=AuthResponse)
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    now = datetime.datetime.now(datetime.timezone.utc)
    client_ip = request.client.host if request.client else "unknown"
    rate_key = f"{client_ip}:{str(req.email)}"
    attempts = [failed_at for failed_at in LOGIN_FAILURES.get(rate_key, []) if now - failed_at < LOGIN_WINDOW]
    LOGIN_FAILURES[rate_key] = attempts
    if len(attempts) >= LOGIN_FAILURE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many failed sign-in attempts. Wait 15 minutes and try again.")
    user = db.query(User).filter(User.email == str(req.email)).first()
    if not user or not verify_password(req.password, user.password_hash):
        attempts.append(now)
        LOGIN_FAILURES[rate_key] = attempts
        raise HTTPException(status_code=401, detail="Invalid email or password")
    LOGIN_FAILURES.pop(rate_key, None)
    return AuthResponse(token=create_token(user), name=user.name, role=user.role, email=user.email)


@app.get("/api/me")
def me(current=Depends(get_current_user)):
    return current


@app.get("/api/config/ice-servers")
def get_ice_servers(current=Depends(get_current_user)):
    servers = [{"urls": ["stun:stun.l.google.com:19302"]}]
    urls = os.getenv("NEUROFOCUS_TURN_URLS", "")
    username = os.getenv("NEUROFOCUS_TURN_USERNAME", "")
    credential = os.getenv("NEUROFOCUS_TURN_CREDENTIAL", "")
    if urls and username and credential:
        servers.append({"urls": [url.strip() for url in urls.split(",") if url.strip()],
                        "username": username, "credential": credential})
    return {"iceServers": servers, "turnConfigured": len(servers) > 1}


class RoomManager:
    """In-memory room membership; run one app worker for this demo build."""
    def __init__(self):
        self.rooms: Dict[str, List[dict]] = {}
        self.codes: Dict[str, datetime.datetime] = {}
        self.questions: Dict[str, set] = {}
        self.answered_questions: Dict[str, set] = {}
        self.lock = __import__("asyncio").Lock()

    def create_code(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        expired = [code for code, created in self.codes.items() if now - created >= datetime.timedelta(hours=12)]
        for code in expired:
            if code not in self.rooms:
                self.questions.pop(code, None)
                self.answered_questions.pop(code, None)
        self.codes = {code: created for code, created in self.codes.items() if code not in expired}
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            code = "NF-" + "".join(secrets.choice(alphabet) for _ in range(6))
            if code not in self.codes:
                self.codes[code] = now
                self.questions[code] = set()
                self.answered_questions[code] = set()
                return code

    def has_code(self, code):
        created = self.codes.get(code)
        if not created:
            return False
        if datetime.datetime.now(datetime.timezone.utc) - created >= datetime.timedelta(hours=12):
            self.codes.pop(code, None)
            if code not in self.rooms:
                self.questions.pop(code, None)
                self.answered_questions.pop(code, None)
            return False
        return True

    async def join(self, room_id: str, websocket: WebSocket, user: dict):
        await websocket.accept()
        async with self.lock:
            peers = self.rooms.setdefault(room_id, [])
            if len(peers) >= 2 or any(peer["user"]["role"] == user["role"] for peer in peers):
                if not peers:
                    self.rooms.pop(room_id, None)
                await websocket.send_json({"type": "system", "event": "room_full"})
                await websocket.close(code=4409)
                return False
            existing = [{"name": peer["user"]["name"], "role": peer["user"]["role"]} for peer in peers]
            peers.append({"ws": websocket, "user": user})
        await websocket.send_json({"type": "system", "event": "room_state", "peers": existing})
        await self.broadcast(room_id, {"type": "system", "event": "peer_joined", "name": user["name"], "role": user["role"]}, exclude=websocket)
        return True

    async def leave(self, room_id: str, websocket: WebSocket):
        async with self.lock:
            peers = self.rooms.get(room_id, [])
            removed = [peer for peer in peers if peer["ws"] is websocket]
            self.rooms[room_id] = [peer for peer in peers if peer["ws"] is not websocket]
            if not self.rooms[room_id]:
                self.rooms.pop(room_id, None)
                self.questions.pop(room_id, None)
                self.answered_questions.pop(room_id, None)
        return removed[0]["user"] if removed else None

    async def broadcast(self, room_id: str, message: dict, exclude: Optional[WebSocket] = None):
        for peer in list(self.rooms.get(room_id, [])):
            if peer["ws"] is exclude:
                continue
            try:
                await peer["ws"].send_json(message)
            except Exception:
                pass


manager = RoomManager()
ROOM_CODE = re.compile(r"^NF-[A-HJ-NP-Z2-9]{6}$")
ROOM_EVENTS = {
    "candidate_tab_hidden", "candidate_tab_returned", "candidate_camera_interrupted",
    "candidate_camera_restored", "candidate_camera_off", "candidate_camera_on",
    "hr_camera_off", "hr_camera_on", "hr_camera_interrupted", "hr_camera_restored",
    "candidate_mic_muted", "candidate_mic_unmuted", "hr_mic_muted", "hr_mic_unmuted",
    "screen_share_started", "screen_share_stopped", "peer_reconnecting", "peer_connected",
}


@app.post("/api/rooms")
def create_room(current=Depends(get_current_user)):
    if current["role"] != "hr":
        raise HTTPException(status_code=403, detail="Only HR users can create interview rooms")
    return {"room": manager.create_code()}


@app.get("/api/rooms/{room_id}/availability")
def room_availability(room_id: str, current=Depends(get_current_user)):
    room_id = room_id.upper()
    if not ROOM_CODE.fullmatch(room_id) or not manager.has_code(room_id):
        raise HTTPException(status_code=404, detail="Room code not found or expired")
    peers = manager.rooms.get(room_id, [])
    if len(peers) >= 2 or any(peer["user"]["role"] == current["role"] for peer in peers):
        raise HTTPException(status_code=409, detail="The room already has someone in your role or is full")
    return {"available": True}


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str, token: str):
    try:
        user = decode_token(token)
    except HTTPException:
        await websocket.close(code=4401)
        return
    room_id = room_id.upper()
    if not ROOM_CODE.fullmatch(room_id):
        await websocket.close(code=4400, reason="Invalid room code")
        return
    if not manager.has_code(room_id):
        await websocket.accept()
        await websocket.send_json({"type": "system", "event": "invalid_room"})
        await websocket.close(code=4404, reason="Room code not found or expired")
        return
    if not await manager.join(room_id, websocket, user):
        return
    window_started = time.monotonic()
    message_count = 0
    try:
        while True:
            raw_message = await websocket.receive_text()
            if len(raw_message) > 64_000:
                await websocket.close(code=1009, reason="Message too large")
                break
            now = time.monotonic()
            if now - window_started >= 10:
                window_started, message_count = now, 0
            message_count += 1
            if message_count > 180:
                await websocket.close(code=1008, reason="Message rate limit exceeded")
                break
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid message format"})
                continue
            if not isinstance(data, dict):
                continue
            msg_type = data.get("type")
            if msg_type == "webrtc" and isinstance(data.get("payload"), dict):
                payload = data["payload"]
                kind = payload.get("kind")
                if kind in ("offer", "answer") and isinstance(payload.get("sdp"), dict):
                    sdp = payload["sdp"]
                    if sdp.get("type") == kind and isinstance(sdp.get("sdp"), str) and len(sdp["sdp"]) <= 32_000:
                        await manager.broadcast(room_id, {"type": "webrtc", "payload": payload, "from": user["name"]}, exclude=websocket)
                elif kind == "candidate" and isinstance(payload.get("candidate"), dict):
                    candidate = payload["candidate"]
                    if isinstance(candidate.get("candidate"), str) and len(candidate["candidate"]) <= 4096:
                        await manager.broadcast(room_id, {"type": "webrtc", "payload": payload, "from": user["name"]}, exclude=websocket)
            elif msg_type == "chat":
                text = data.get("text")
                if isinstance(text, str) and text.strip():
                    await manager.broadcast(room_id, {"type": "chat", "text": text.strip()[:1000], "from": user["name"], "user_id": user["sub"], "role": user["role"], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()}, exclude=websocket)
            elif msg_type == "question" and user["role"] == "hr":
                prompt = data.get("text")
                category = data.get("category")
                if isinstance(prompt, str) and prompt.strip() and category in ("coding", "aptitude", "company", "behavioral"):
                    question_id = data.get("id")
                    if not isinstance(question_id, str) or not question_id:
                        question_id = secrets.token_urlsafe(8)
                    question_id = question_id[:64]
                    manager.questions.setdefault(room_id, set()).add(question_id)
                    await manager.broadcast(room_id, {"type": "question", "id": question_id, "text": prompt.strip()[:4000], "category": category, "from": user["name"], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()}, exclude=websocket)
            elif msg_type == "answer" and user["role"] == "candidate":
                answer = data.get("text")
                question_id = data.get("question_id")
                if isinstance(answer, str) and isinstance(question_id, str) and answer.strip() and question_id in manager.questions.get(room_id, set()) and question_id not in manager.answered_questions.get(room_id, set()):
                    is_code = data.get("format") == "code"
                    language = data.get("language") if data.get("language") in ("python", "java", "javascript", "html", "css", "cpp", "other") else "other"
                    manager.answered_questions.setdefault(room_id, set()).add(question_id)
                    await manager.broadcast(room_id, {"type": "answer", "question_id": question_id[:64], "text": answer[:12000], "format": "code" if is_code else "text", "language": language if is_code else "", "from": user["name"], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()}, exclude=websocket)
                else:
                    await websocket.send_json({"type": "error", "message": "That answer does not match a question currently shared in this room."})
            elif msg_type == "room_event" and isinstance(data.get("event"), str) and data["event"] in ROOM_EVENTS:
                event = data["event"]
                if event.startswith("candidate_") and user["role"] != "candidate":
                    continue
                if (event.startswith("hr_camera_") or event.startswith("hr_mic_")) and user["role"] != "hr":
                    continue
                if event in ("peer_reconnecting",) and user["role"] != "candidate":
                    continue
                payload = {"type": "room_event", "event": data["event"], "from": user["name"], "role": user["role"], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                for peer in list(manager.rooms.get(room_id, [])):
                    deliver_to_hr = peer["user"]["role"] == "hr"
                    deliver_hr_media_state_to_candidate = peer["user"]["role"] == "candidate" and (event.startswith("hr_camera_") or event.startswith("hr_mic_"))
                    if peer["ws"] is not websocket and (deliver_to_hr or deliver_hr_media_state_to_candidate):
                        try:
                            await peer["ws"].send_json(payload)
                        except Exception:
                            pass
            elif msg_type == "renegotiate_request" and user["role"] == "candidate":
                await manager.broadcast(room_id, {"type": "renegotiate_request", "restart_ice": data.get("restart_ice") is True}, exclude=websocket)
            elif msg_type == "screen_share_state":
                await manager.broadcast(room_id, {"type": "screen_share_state", "active": bool(data.get("active")), "from": user["name"]}, exclude=websocket)
    except WebSocketDisconnect:
        pass
    finally:
        departed = await manager.leave(room_id, websocket)
        if departed:
            await manager.broadcast(room_id, {"type": "system", "event": "peer_left", "name": departed["name"], "role": departed["role"]})


app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")


@app.get("/")
def serve_index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/{page_name}.html")
def serve_page(page_name: str):
    path = os.path.join(FRONTEND_DIR, f"{page_name}.html")
    if os.path.isfile(path):
        return FileResponse(path)
    raise HTTPException(status_code=404, detail="Not found")
