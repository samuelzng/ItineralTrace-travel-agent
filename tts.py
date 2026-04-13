import asyncio
import logging
import tempfile
import os
import edge_tts

logger = logging.getLogger(__name__)

DEFAULT_VOICE = "en-US-AriaNeural"


async def synthesize(
    text: str,
    output_path: str | None = None,
    voice: str = DEFAULT_VOICE,
) -> str:
    """Convert text to speech using edge-tts. Returns the output file path."""
    if output_path is None:
        fd, output_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)

    logger.info("Synthesizing TTS → %s (voice: %s)", output_path, voice)
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_path)
    # Verify the file has actual audio content (not empty / corrupt)
    file_size = os.path.getsize(output_path)
    if file_size < 256:
        logger.warning("TTS produced suspiciously small file (%d bytes), discarding", file_size)
        os.unlink(output_path)
        raise RuntimeError(f"TTS produced empty/corrupt audio ({file_size} bytes)")
    logger.info("TTS saved: %s (%d bytes)", output_path, file_size)
    return output_path


def synthesize_sync(
    text: str,
    output_path: str | None = None,
    voice: str = DEFAULT_VOICE,
) -> str:
    """Synchronous wrapper around synthesize()."""
    return asyncio.run(synthesize(text, output_path, voice))


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)
    text = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "Hello, I am your travel assistant."
    path = synthesize_sync(text)
    print(f"Audio saved to: {path}")
