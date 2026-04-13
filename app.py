"""FastAPI backend — wires together agent, STT, TTS, and renderer."""

import asyncio
import logging
import os
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import json as json_mod

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import re

import agent as travel_agent
import renderer
from tts import synthesize
from user_memory import load_preferences, save_preferences, load_memories, save_memory, delete_memory, update_memory

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent

# Unique ID per server process — lets the client detect restarts
_BOOT_ID = str(uuid.uuid4())


_BOOT_MARKER = Path(tempfile.gettempdir()) / "travel_agent_boot_marker"
_BOOT_MARKER_MAX_AGE = 1800  # 30 minutes — treat stale marker as cold start


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup — clear user data on fresh start, but not on hot-reload."""
    is_reload = False
    if _BOOT_MARKER.exists():
        age = time.time() - _BOOT_MARKER.stat().st_mtime
        is_reload = age < _BOOT_MARKER_MAX_AGE

    if not is_reload:
        for f in (BASE_DIR / "user_preferences.json", BASE_DIR / "user_memories.json"):
            if f.exists():
                f.unlink()
                logger.info("Cleared %s for fresh session", f.name)

    # Touch marker for reload detection
    _BOOT_MARKER.write_text(str(os.getpid()))

    # Pre-load Whisper model in background so first STT call is fast
    asyncio.get_event_loop().run_in_executor(None, _preload_whisper)
    yield
    # Cleanup marker on shutdown so next `python app.py` is a fresh start
    _BOOT_MARKER.unlink(missing_ok=True)


app = FastAPI(title="ItineraTrace", lifespan=lifespan)
STATIC_DIR = BASE_DIR / "static"
AUDIO_DIR = STATIC_DIR / "audio"
UPLOAD_DIR = STATIC_DIR / "uploads"
IMG_CACHE_DIR = STATIC_DIR / "imgcache"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
IMG_CACHE_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Max age for TTS audio files before cleanup (seconds)
_AUDIO_MAX_AGE = 300

# In-memory session store: session_id → conversation history
_sessions: dict[str, list] = {}
# Session last-access time for TTL cleanup
_session_atime: dict[str, float] = {}
_SESSION_TTL = 7200  # 2 hours
# Per-session cancel events: session_id → threading.Event
_cancel_events: dict[str, threading.Event] = {}


# ── Models ─────────────────────────────────────────────────────────────────────

def _preload_whisper():
    """Load Whisper model at startup so first transcription is fast."""
    try:
        from stt import _get_model
        _get_model()
        logger.info("Whisper model pre-loaded")
    except Exception as e:
        logger.warning("Whisper pre-load failed (will retry on first use): %s", e)


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=2000)
    session_id: str = ""
    image_id: str = ""


class ChatResponse(BaseModel):
    response: dict       # {"type": "text"|"itinerary", "data": ...}
    audio_url: str
    session_id: str


class TranscribeResponse(BaseModel):
    text: str


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/boot-id")
async def boot_id():
    """Return the current server boot ID so the client can detect restarts."""
    return {"id": _BOOT_ID}


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the main UI."""
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/chat")
async def chat(req: ChatRequest):
    """Process a text message — streams progress events via SSE, then final response."""
    session_id = req.session_id or str(uuid.uuid4())
    history = _sessions.setdefault(session_id, [])
    _session_atime[session_id] = time.time()

    logger.info("[%s] User: %s", session_id, req.message)

    cancel_event = threading.Event()
    _cancel_events[session_id] = cancel_event

    # Load image bytes if an image was uploaded
    image_bytes = None
    image_mime = "image/jpeg"
    if req.image_id:
        img_path = UPLOAD_DIR / req.image_id
        if img_path.exists() and img_path.parent == UPLOAD_DIR:
            image_bytes = img_path.read_bytes()
            suffix = img_path.suffix.lower()
            mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".gif": "image/gif", ".webp": "image/webp"}
            image_mime = mime_map.get(suffix, "image/jpeg")

    def _sse(event: str, data: dict) -> str:
        return f"data: {json_mod.dumps({'event': event, **data})}\n\n"

    async def event_stream():
        loop = asyncio.get_running_loop()
        progress_q: asyncio.Queue[str | None] = asyncio.Queue()
        result_holder: dict = {}

        def on_progress(msg: str):
            loop.call_soon_threadsafe(progress_q.put_nowait, msg)

        def run_agent_sync():
            try:
                result_holder["result"] = travel_agent.run_agent(
                    req.message, history, cancel_event,
                    image_bytes, image_mime, on_progress,
                )
            except Exception as e:
                result_holder["error"] = e
            finally:
                loop.call_soon_threadsafe(progress_q.put_nowait, None)

        agent_thread = threading.Thread(target=run_agent_sync, daemon=True)
        agent_thread.start()

        # Stream progress events until agent finishes
        while True:
            msg = await progress_q.get()
            if msg is None:
                break
            yield _sse("progress", {"text": msg})

        agent_thread.join()
        _cancel_events.pop(session_id, None)

        # Handle errors
        if "error" in result_holder:
            err = result_holder["error"]
            if isinstance(err, travel_agent.AgentCancelled):
                yield _sse("error", {"text": "Request cancelled"})
            else:
                logger.error("[%s] Agent error: %s", session_id, err)
                yield _sse("error", {"text": str(err)})
            return

        result = result_holder["result"]
        text = result.get("text", "")
        itinerary = result.get("itinerary")
        structured = renderer.render(result)

        logger.info("[%s] Response ready (type=%s)", session_id, structured["type"])
        _cleanup_old_audio()
        _cleanup_stale_sessions()

        # Synthesize TTS first, then send everything together in one event
        audio_url = ""
        tts_text = _tts_text(text, itinerary)
        if tts_text.strip():
            try:
                # yield _sse("progress", {"text": "Generating audio..."})
                audio_filename = f"{uuid.uuid4()}.mp3"
                audio_path = str(AUDIO_DIR / audio_filename)
                await synthesize(tts_text, audio_path)
                audio_url = f"/static/audio/{audio_filename}"
            except Exception as e:
                logger.warning("TTS failed (non-fatal): %s", e)

        yield _sse("done", {
            "response": structured,
            "audio_url": audio_url,
            "session_id": session_id,
        })

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(audio: UploadFile = File(...)):
    """Transcribe an uploaded audio file to text using Whisper."""
    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        from stt import transcribe as whisper_transcribe
        text = await asyncio.to_thread(whisper_transcribe, tmp_path)
    except Exception as e:
        logger.error("STT failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    logger.info("Transcribed: %s", text)
    return TranscribeResponse(text=text)


@app.post("/upload-image")
async def upload_image(image: UploadFile = File(...)):
    """Save an uploaded image and return its ID for use in /chat."""
    suffix = Path(image.filename or "image.jpg").suffix or ".jpg"
    if suffix.lower() not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        raise HTTPException(status_code=400, detail="Unsupported image format")
    image_id = f"{uuid.uuid4()}{suffix}"
    dest = UPLOAD_DIR / image_id
    dest.write_bytes(await image.read())
    logger.info("Uploaded image: %s", image_id)
    # Clean up old uploads (>5 min)
    _cleanup_old_uploads()
    return {"image_id": image_id, "url": f"/static/uploads/{image_id}"}


@app.get("/imgproxy")
async def image_proxy(url: str):
    """Cache and serve external images locally to prevent broken links."""
    import hashlib
    import httpx
    if not url:
        raise HTTPException(status_code=400, detail="Missing url param")
    # Deterministic filename from URL
    ext = Path(url.split("?")[0]).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        ext = ".jpg"
    filename = hashlib.md5(url.encode()).hexdigest() + ext
    cached = IMG_CACHE_DIR / filename
    if cached.exists():
        return FileResponse(cached, media_type=f"image/{ext.lstrip('.')}")
    # Download and cache
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=8) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Upstream image failed")
            ct = resp.headers.get("content-type", "")
            if "image" not in ct and len(resp.content) < 1000:
                raise HTTPException(status_code=502, detail="Not an image")
            cached.write_bytes(resp.content)
            return FileResponse(cached, media_type=ct or f"image/{ext.lstrip('.')}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Image fetch failed: {e}")


@app.get("/preferences")
async def get_preferences():
    """Return saved user preferences (if any)."""
    return load_preferences() or {}


@app.post("/preferences")
async def set_preferences(req: Request):
    """Save user preferences from the sidebar editor."""
    data = await req.json()
    return save_preferences(**data)


@app.get("/memories")
async def get_memories():
    """Return all saved user memories."""
    return load_memories()


@app.post("/memories")
async def add_memory(req: Request):
    """Manually add a memory."""
    data = await req.json()
    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Memory text is required")
    return save_memory(text)


@app.put("/memories/{memory_id}")
async def edit_memory(memory_id: str, req: Request):
    """Update a memory's text."""
    data = await req.json()
    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Memory text is required")
    return update_memory(memory_id, text)


@app.delete("/memories/{memory_id}")
async def remove_memory(memory_id: str):
    """Delete a memory by ID."""
    return delete_memory(memory_id)


@app.delete("/session/{session_id}")
async def clear_session(session_id: str):
    """Clear conversation history for a session."""
    # Signal any in-flight agent to stop
    cancel_event = _cancel_events.pop(session_id, None)
    if cancel_event:
        cancel_event.set()
    _sessions.pop(session_id, None)
    _session_atime.pop(session_id, None)
    _cleanup_old_audio()  # Clean up expired audio only
    return {"cleared": session_id}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _cleanup_old_audio(max_age: int = _AUDIO_MAX_AGE):
    """Remove TTS audio files older than max_age seconds (0 = all)."""
    now = time.time()
    for f in AUDIO_DIR.glob("*.mp3"):
        try:
            if max_age == 0 or (now - f.stat().st_mtime) > max_age:
                f.unlink()
        except OSError:
            pass


def _cleanup_stale_sessions():
    """Remove sessions that haven't been accessed within the TTL."""
    now = time.time()
    stale = [sid for sid, atime in _session_atime.items() if now - atime > _SESSION_TTL]
    for sid in stale:
        _sessions.pop(sid, None)
        _session_atime.pop(sid, None)
        _cancel_events.pop(sid, None)
    if stale:
        logger.info("Cleaned up %d stale sessions", len(stale))


def _cleanup_old_uploads(max_age: int = 1800):
    """Remove uploaded images older than max_age seconds."""
    now = time.time()
    for f in UPLOAD_DIR.iterdir():
        try:
            if f.is_file() and (now - f.stat().st_mtime) > max_age:
                f.unlink()
        except OSError:
            pass


def _strip_markdown(text: str) -> str:
    """Remove common markdown so edge-tts reads cleanly."""
    text = re.sub(r'```.*?```', '', text, flags=re.DOTALL)   # code blocks
    text = re.sub(r'`[^`]*`', '', text)                       # inline code
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)             # bold
    text = re.sub(r'\*(.+?)\*', r'\1', text)                  # italic
    text = re.sub(r'#+\s*', '', text)                          # headings
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)  # bullets
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)  # numbered lists
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)     # links
    text = re.sub(r'[_~|]', '', text)                          # leftover symbols
    text = re.sub(r'\n{2,}', '. ', text)                       # blank lines → pause
    text = re.sub(r'\n', ' ', text)
    return text.strip()


def _tts_text(raw_text: str, itinerary: dict | None) -> str:
    """Produce a clean, speakable summary for TTS.

    For itineraries, only speak a brief overview (destination + weather + place
    highlights per day) to keep audio short and snappy.
    """
    if not itinerary:
        return _strip_markdown(raw_text)

    dest = itinerary.get("destination", "your destination")
    summary = itinerary.get("weather_summary", "")
    days = itinerary.get("days", [])
    n_days = len(days)

    parts = [f"Here is your {n_days}-day itinerary for {dest}. {summary}"]

    for i, day in enumerate(days, 1):
        weather = day.get("weather", {})
        condition = weather.get("condition", "")
        activities = day.get("activities", [])
        place_names = [a.get("place", "") for a in activities if a.get("place")]

        weather_str = f" {condition}." if condition else ""
        highlights = ", ".join(place_names[:4])
        parts.append(f"Day {i}:{weather_str} {highlights}.")

    return " ".join(parts)


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    import sys
    is_dev = "--dev" in sys.argv
    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=8000,
        reload=is_dev,
        reload_includes=["*.py"] if is_dev else None,
        reload_excludes=[".*"] if is_dev else None,
    )
