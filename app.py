"""FastAPI backend — wires together agent, STT, TTS, and renderer."""

import asyncio
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agent as travel_agent
import renderer
from tts import synthesize

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Travel Agent")

# Unique ID per server process — lets the client detect restarts
_BOOT_ID = str(uuid.uuid4())


@app.on_event("startup")
async def _reset_on_startup():
    """Each server start assumes a fresh user — clear prefs and old audio."""
    prefs_file = BASE_DIR / "user_preferences.json"
    if prefs_file.exists():
        prefs_file.unlink()
        logger.info("Cleared user_preferences.json for fresh session")

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
AUDIO_DIR = STATIC_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Max age for TTS audio files before cleanup (seconds)
_AUDIO_MAX_AGE = 300

# In-memory session store: session_id → conversation history
_sessions: dict[str, list] = {}
# Per-session cancel events: session_id → threading.Event
_cancel_events: dict[str, threading.Event] = {}


# ── Models ─────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str = ""


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


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """Process a text message through the agent and return response + TTS audio."""
    session_id = req.session_id or str(uuid.uuid4())
    history = _sessions.setdefault(session_id, [])

    logger.info("[%s] User: %s", session_id, req.message)

    # Create a cancel event for this request (replaces any prior one for this session)
    cancel_event = threading.Event()
    _cancel_events[session_id] = cancel_event

    # Run synchronous agent in a thread to avoid blocking the event loop
    try:
        result = await asyncio.to_thread(
            travel_agent.run_agent, req.message, history, cancel_event
        )
    except travel_agent.AgentCancelled:
        logger.info("[%s] Agent cancelled", session_id)
        raise HTTPException(status_code=499, detail="Request cancelled")
    finally:
        _cancel_events.pop(session_id, None)

    text = result.get("text", "")
    itinerary = result.get("itinerary")
    structured = renderer.render(result)

    # Generate TTS for the response
    tts_text = _tts_text(text, itinerary)
    audio_filename = f"{uuid.uuid4()}.mp3"
    audio_path = str(AUDIO_DIR / audio_filename)
    await synthesize(tts_text, audio_path)
    audio_url = f"/static/audio/{audio_filename}"

    logger.info("[%s] Response ready (type=%s)", session_id, structured["type"])

    _cleanup_old_audio()

    return ChatResponse(
        response=structured,
        audio_url=audio_url,
        session_id=session_id,
    )


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
        os.unlink(tmp_path)

    logger.info("Transcribed: %s", text)
    return TranscribeResponse(text=text)


@app.get("/preferences")
async def get_preferences():
    """Return saved user preferences (if any)."""
    from user_memory import load_preferences
    return load_preferences() or {}


@app.post("/preferences")
async def set_preferences(req: Request):
    """Save user preferences from the sidebar editor."""
    from user_memory import save_preferences
    data = await req.json()
    result = save_preferences(**data)
    return result


@app.delete("/session/{session_id}")
async def clear_session(session_id: str):
    """Clear conversation history for a session."""
    # Signal any in-flight agent to stop
    cancel_event = _cancel_events.pop(session_id, None)
    if cancel_event:
        cancel_event.set()
    _sessions.pop(session_id, None)
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


def _strip_markdown(text: str) -> str:
    """Remove common markdown so edge-tts reads cleanly."""
    import re
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
    """Produce a clean, speakable summary for TTS."""
    if not itinerary:
        return _strip_markdown(raw_text)

    dest = itinerary.get("destination", "your destination")
    summary = itinerary.get("weather_summary", "")
    days = itinerary.get("days", [])
    n_days = len(days)

    parts = [f"Here is your {n_days}-day itinerary for {dest}. {summary}"]

    for i, day in enumerate(days, 1):
        date = day.get("date", f"Day {i}")
        weather = day.get("weather", {})
        condition = weather.get("condition", "")
        temp_high = weather.get("temp_high", "")
        temp_low = weather.get("temp_low", "")
        activities = day.get("activities", [])

        weather_str = f"{condition}, high {temp_high} degrees, low {temp_low} degrees." if condition else ""
        parts.append(f"Day {i}, {date}. {weather_str}")

        for j, act in enumerate(activities, 1):
            place = act.get("place", "")
            time = act.get("time", "")
            description = act.get("description", "")
            duration = act.get("duration_minutes", "")
            transport = act.get("transport_to_next")

            parts.append(
                f"Activity {j}: At {time}, visit {place}. {description} "
                f"Spend about {duration} minutes here."
            )
            if transport:
                mode = transport.get("mode", "")
                dur = transport.get("duration", "")
                dist = transport.get("distance", "")
                parts.append(f"Then travel by {mode}, {dur}, {dist}.")

    return " ".join(parts)


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
