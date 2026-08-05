"""
Whisper Transcription Service
=============================
A Flask microservice for audio transcription using faster-whisper.
Can be deployed separately or run alongside the main bot.

Endpoints:
- POST /transcribe - Transcribe audio file
- GET /health - Health check
- GET /models - List available models
"""

from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
import tempfile
import os
import logging
from pathlib import Path
from datetime import datetime
from functools import lru_cache
import platform

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Configuration
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")  # tiny, base, small, medium, large
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")  # cpu, cuda
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")  # int8, int16, float16, float32
MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE_MB", "25")) * 1024 * 1024  # 25MB default
ALLOWED_EXTENSIONS = {'.ogg', '.wav', '.mp3', '.m4a', '.webm', '.flac', '.opus'}

# Cross-platform model cache directory.
# Prefer a project-local folder so we never hit sandbox/ACL issues on system
# paths (e.g. %LOCALAPPDATA% inside a restricted Windows shell).  Use the
# explicit env override if provided.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_default_cache = _PROJECT_ROOT / ".whisper_cache"
_env_override = os.getenv("WHISPER_CACHE_DIR")
if _env_override:
    _default_cache = Path(_env_override)
elif platform.system() != "Windows":
    # On Unix the standard XDG-style cache is perfectly fine
    _default_cache = Path.home() / ".cache" / "whisper_models"
WHISPER_CACHE_DIR = _default_cache

try:
    WHISPER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as exc:  # pragma: no cover - last-resort fallback
    logger.warning("Failed to create whisper cache dir at %s: %s — falling back to temp dir",
                   WHISPER_CACHE_DIR, exc)
    WHISPER_CACHE_DIR = Path(tempfile.gettempdir()) / "whisper_models"
    WHISPER_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Global model cache
_models = {}

def get_model(model_size: str = None) -> WhisperModel:
    """Get or create a Whisper model instance."""
    size = model_size or MODEL_SIZE
    if size not in _models:
        logger.info(f"Loading Whisper model: {size} on {DEVICE} with {COMPUTE_TYPE} (cache: {WHISPER_CACHE_DIR})")
        try:
            _models[size] = WhisperModel(
                size,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root=str(WHISPER_CACHE_DIR)
            )
        except TypeError:
            # Older versions of faster-whisper don't accept `download_root`
            logger.warning("faster-whisper doesn't accept `download_root`; using default cache location")
            _models[size] = WhisperModel(size, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _models[size]

def allowed_file(filename: str) -> bool:
    """Check if file extension is allowed."""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS

@app.route("/health")
def health():
    """Health check endpoint — lowercase `"healthy"` is what VoiceService probes for."""
    return jsonify({
        "status": "healthy",
        "service": "whisper-transcription",
        "timestamp": datetime.utcnow().isoformat(),
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "loaded_models": list(_models.keys())
    })

@app.route("/models")
def list_models():
    """List available Whisper models."""
    return jsonify({
        "available": ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        "current": MODEL_SIZE,
        "loaded": list(_models.keys())
    })

@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Transcribe audio file to text.
    
    Expected: multipart/form-data with 'audio' file
    Optional params: language, model, vad_filter, beam_size
    
    Returns: { "text": "...", "language": "...", "duration": 12.5 }
    """
    start_time = datetime.utcnow()
    
    # Check if audio file is present
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    
    audio_file = request.files["audio"]
    
    if audio_file.filename == "":
        return jsonify({"error": "No file selected"}), 400
    
    # Check file extension
    if not allowed_file(audio_file.filename):
        return jsonify({
            "error": f"Unsupported file format. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        }), 400
    
    # Check file size
    audio_file.seek(0, os.SEEK_END)
    file_size = audio_file.tell()
    audio_file.seek(0)
    
    if file_size > MAX_FILE_SIZE:
        return jsonify({
            "error": f"File too large. Maximum size: {MAX_FILE_SIZE // (1024*1024)}MB"
        }), 413
    
    # Get optional parameters
    language = request.form.get("language")  # None = auto-detect
    model_size = request.form.get("model", MODEL_SIZE)
    vad_filter = request.form.get("vad_filter", "true").lower() == "true"
    beam_size = int(request.form.get("beam_size", "5"))
    
    # Save to temporary file
    temp_file = None
    try:
        suffix = Path(audio_file.filename).suffix.lower()
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
            audio_file.save(temp.name)
            temp_file = temp.name
        
        # Load model
        model = get_model(model_size)
        
        # Transcribe
        logger.info(f"Transcribing {audio_file.filename} ({file_size} bytes) with {model_size}")
        segments, info = model.transcribe(
            temp_file,
            language=language if language else None,
            vad_filter=vad_filter,
            beam_size=beam_size,
            word_timestamps=False
        )
        
        # Collect results
        text_parts = []
        total_duration = 0
        
        for segment in segments:
            text_parts.append(segment.text)
            total_duration = max(total_duration, segment.end)
        
        text = " ".join(text_parts).strip()
        
        processing_time = (datetime.utcnow() - start_time).total_seconds()
        
        logger.info(f"Transcription completed in {processing_time:.2f}s: {len(text)} chars, {total_duration:.1f}s audio")
        
        return jsonify({
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": round(total_duration, 2),
            "processing_time": round(processing_time, 2),
            "model": model_size
        })
        
    except Exception as e:
        logger.error(f"Transcription error: {str(e)}", exc_info=True)
        return jsonify({"error": f"Transcription failed: {str(e)}"}), 500
    
    finally:
        # Cleanup temp file
        if temp_file and os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception as e:
                logger.warning(f"Failed to remove temp file: {e}")

@app.errorhandler(413)
def file_too_large(e):
    return jsonify({"error": "File too large"}), 413

@app.errorhandler(500)
def internal_error(e):
    logger.error(f"Internal server error: {e}", exc_info=True)
    return jsonify({"error": "Internal server error"}), 500

if __name__ == "__main__":
    # Pre-load model on startup
    logger.info("Starting Whisper Transcription Service...")
    get_model()
    logger.info("Model loaded, starting Flask server...")
    
    host = os.getenv("TRANSCRIPTION_HOST", "127.0.0.1")
    port = int(os.getenv("TRANSCRIPTION_PORT", "5000"))
    logger.info("Transcription service listening on %s:%s", host, port)
    app.run(host=host, port=port, debug=False, threaded=True)
