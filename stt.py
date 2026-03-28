import logging
import whisper

logger = logging.getLogger(__name__)

_model = None


def _get_model():
    global _model
    if _model is None:
        logger.info("Loading Whisper base model...")
        _model = whisper.load_model("base")
        logger.info("Whisper model loaded.")
    return _model


def transcribe(audio_file_path: str) -> str:
    """Convert an audio file to text using Whisper base model."""
    logger.info("Transcribing: %s", audio_file_path)
    model = _get_model()
    result = model.transcribe(audio_file_path)
    text = result["text"].strip()
    logger.info("Transcription: %s", text)
    return text


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 2:
        print("Usage: python stt.py <audio_file>")
        sys.exit(1)
    print(transcribe(sys.argv[1]))
