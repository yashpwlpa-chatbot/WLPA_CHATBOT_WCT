/**
 * VoiceService
 * ------------
 * Unified voice transcription service supporting multiple backends:
 * 1. Local faster-whisper (via HTTP microservice)
 * 2. OpenAI Whisper API (fallback)
 * 3. Future: Google STT, Azure Speech, etc.
 *
 * The interface is intentionally small (`transcribe(buffer)`) so we can
 * swap backends without touching the bot or controllers.
 */

const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const config = require('../config');
const logger = require('../utils/logger');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

function normalizeTranscriptionServiceUrl(value) {
  const configuredUrl = String(value || 'http://127.0.0.1:5000').trim();

  try {
    const parsed = new URL(configuredUrl);
    if (parsed.hostname === 'localhost' || parsed.hostname === '::1') {
      parsed.hostname = '127.0.0.1';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (_err) {
    return configuredUrl.replace(/\/+$/, '');
  }
}

class VoiceService {
  constructor() {
    // Configuration
    this.transcriptionServiceUrl = normalizeTranscriptionServiceUrl(
      config.transcription?.serviceUrl || process.env.TRANSCRIPTION_SERVICE_URL
    );
    this.openaiApiKey = config.whisper?.apiKey || process.env.WHISPER_API_KEY;
    this.useLocalService = config.transcription?.useLocal !== false; // Default to local
    this.defaultModel = config.transcription?.model || process.env.WHISPER_MODEL || 'base';
    this.defaultLanguage = config.transcription?.defaultLanguage || process.env.WHISPER_LANGUAGE || 'en';
    
    // Timeout settings
    this.transcriptionTimeout = config.transcription?.timeout || 60000; // 60 seconds
    this.healthTimeout = config.transcription?.healthTimeout || 3000;
    this.transcriptionRetries = Math.max(1, config.transcription?.retries || 3);
    this.transcriptionRetryDelay = Math.max(0, config.transcription?.retryDelay || 1000);
    this.maxFileSize = config.transcription?.maxFileSize || 25 * 1024 * 1024; // 25MB

    // Liveness cache (avoids repeated 3s health-check timeouts per message).
    // The bot handles a lot of messages; probing the health endpoint every
    // single time would make voice latency intolerable on flaky networks.
    this._backendCache = null;       // { backend: 'local'|'openai'|null, ts: Number }
    this._backendCacheTTL = 30000;   // Re-check every 30s
    this._backendWarnedDown = false; // Suppress repetitive "unavailable" warns
  }

  /**
   * True if a usable STT backend exists.  If only the local service is
   * configured, we rely on the cached liveness probe so this stays cheap.
   */
  isAvailable() {
    if (Boolean(this.openaiApiKey)) return true;
    if (!this.useLocalService) return false;
    // We need the local service, so refresh the probe if it's stale/missing.
    // We don't await here — callers that need the backend synchronously call
    // _getBackend() before transcribing anyway.
    if (!this._backendCache || (Date.now() - this._backendCache.ts) > this._backendCacheTTL) {
      this._probeBackendCache().catch(() => {});
    }
    // If we already probed recently and got a backend, report available.
    return Boolean(this._backendCache && this._backendCache.backend);
  }

  async _probeBackendCache() {
    try {
      const backend = await this._resolveBackend(true); // force probe
      this._backendCache = { backend, ts: Date.now() };
      if (!backend && !this._backendWarnedDown) {
        logger.warn('VoiceService: no transcription backend reachable');
        this._backendWarnedDown = true;
      }
      return backend;
    } catch (err) {
      this._backendCache = { backend: null, ts: Date.now() };
      return null;
    }
  }

  /**
   * Probe the configured transcription backends during application startup.
   * This removes the first-request race when the local service is ready.
   */
  async warmup() {
    const backend = await this._probeBackendCache();
    logger.info('VoiceService startup probe completed', {
      backend: backend || 'none',
      localService: this.useLocalService ? this.transcriptionServiceUrl : null,
      openaiConfigured: Boolean(this.openaiApiKey),
    });
    return backend;
  }

  /**
   * Get the best available transcription backend.
   * Priority: Local service > OpenAI API.
   * Uses a 30s liveness cache so we don't spam /health checks.
   */
  async _getBackend() {
    const now = Date.now();
    if (
      this._backendCache &&
      (now - this._backendCache.ts) < this._backendCacheTTL
    ) {
      return this._backendCache.backend;
    }
    return await this._probeBackendCache();
  }

  /**
   * Actual backend resolution.  `_getBackend()` wraps this with caching.
   */
  async _resolveBackend(forceLog) {
    if (this.useLocalService) {
      for (let attempt = 1; attempt <= this.transcriptionRetries; attempt += 1) {
        try {
          const response = await axios.get(`${this.transcriptionServiceUrl}/health`, { timeout: this.healthTimeout });
          if (response.data.status === 'healthy') {
            this._backendWarnedDown = false;
            return 'local';
          }
        } catch (err) {
          if (attempt < this.transcriptionRetries && this._isRetryableError(err)) {
            const delay = this.transcriptionRetryDelay * attempt;
            logger.warn('Local transcription health check failed; retrying', {
              attempt,
              retries: this.transcriptionRetries,
              delayMs: delay,
              error: err.message || '',
            });
            await this._sleep(delay);
            continue;
          }

          if (forceLog || !this._backendWarnedDown) {
            logger.warn('Local transcription service unavailable, falling back to OpenAI', { error: err.message || '' });
          }
        }
      }
    }
    
    if (this.openaiApiKey) {
      return 'openai';
    }
    
    return null;
  }

  /**
   * Transcribe an audio buffer using the best available backend.
   *
   * @param {Buffer} buffer - Raw audio bytes.
   * @param {Object} options - Transcription options
   * @param {string} [options.filename='voice.ogg'] - File name for the API
   * @param {string} [options.language] - Language hint (e.g., 'en', 'hi', 'mr')
   * @param {string} [options.model] - Model to use (e.g., 'base', 'small', 'medium')
   * @returns {Promise<string>} transcription text
   */
  async transcribe(buffer, options = {}) {
    if (!buffer || buffer.length === 0) {
      const err = new Error('Empty audio buffer');
      err.code = 'EMPTY_AUDIO';
      throw err;
    }

    if (buffer.length > this.maxFileSize) {
      const err = new Error(`Audio file too large (max ${this.maxFileSize / 1024 / 1024}MB)`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    let backend = await this._getBackend();
    
    if (!backend) {
      const err = new Error('No transcription backend available. Configure TRANSCRIPTION_SERVICE_URL or WHISPER_API_KEY');
      err.code = 'NO_BACKEND';
      throw err;
    }

    const filename = options.filename || 'voice.ogg';
    const language = options.language || this.defaultLanguage;
    const model = options.model || this.defaultModel;

    logger.info('voice_transcription_request', { 
      bytes: buffer.length, 
      backend, 
      language, 
      model,
      filename 
    });

    try {
      let text;
      
      if (backend === 'local') {
        try {
          text = await this._transcribeLocal(buffer, filename, language, model);
        } catch (err) {
          if (!this.openaiApiKey || !this._isRetryableError(err)) throw err;

          logger.warn('Local transcription failed; falling back to OpenAI', {
            error: err.message || '',
          });
          backend = 'openai';
          text = await this._transcribeOpenAI(buffer, filename, language);
        }
      } else {
        text = await this._transcribeOpenAI(buffer, filename, language);
      }
      
      const result = (text || '').trim();

      // If the backend processed the audio but returned empty text, it means
      // either silence-only or heavily-accented / inaudible speech.  Surface
      // this to the user as a transcription failure so we don't then try to
      // run a WLPA search with an empty question.
      if (!result) {
        const emptyErr = new Error('Could not detect any speech in the voice message');
        emptyErr.code = 'EMPTY_AUDIO';
        throw emptyErr;
      }
      logger.info('voice_transcription_response', { 
        length: result.length, 
        backend,
        model 
      });
      
      return result;
      
    } catch (err) {
      logger.error('Transcription failed', { 
        backend, 
        error: err.message, 
        code: err.code 
      });
      
      // Add error codes for better handling upstream
      if (!err.code) {
        err.code = backend === 'local' ? 'LOCAL_TRANSCRIPTION_FAILED' : 'WHISPER_FAILED';
      }
      throw err;
    }
  }

  /**
   * Transcribe using local faster-whisper microservice
   */
  async _transcribeLocal(buffer, filename, language, model) {
    let lastError;

    for (let attempt = 1; attempt <= this.transcriptionRetries; attempt += 1) {
      try {
        const fileStream = Buffer.isBuffer(buffer) ? Readable.from(buffer) : buffer;
        const form = new FormData();
        form.append('audio', fileStream, {
          filename,
          contentType: this._getContentType(filename),
          knownLength: Buffer.isBuffer(buffer) ? buffer.length : undefined,
        });
        form.append('language', language);
        form.append('model', model);
        form.append('vad_filter', 'true');
        form.append('beam_size', '5');

        const response = await axios.post(
          `${this.transcriptionServiceUrl}/transcribe`,
          form,
          {
            headers: {
              ...form.getHeaders(),
            },
            timeout: this.transcriptionTimeout,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );

        if (response.data.error) {
          const serviceError = new Error(response.data.error);
          serviceError.retryable = false;
          throw serviceError;
        }

        return response.data.text;
      } catch (err) {
        lastError = err;
        if (attempt >= this.transcriptionRetries || !this._isRetryableError(err)) break;

        const delay = this.transcriptionRetryDelay * attempt;
        logger.warn('Local transcription request failed; retrying', {
          attempt,
          retries: this.transcriptionRetries,
          delayMs: delay,
          error: err.message || '',
        });
        await this._sleep(delay);
      }
    }

    this._backendCache = null;
    logger.error('Local transcription request failed after retries', {
      retries: this.transcriptionRetries,
      error: lastError?.message || 'unknown error',
    });
    throw lastError;
  }

  _isRetryableError(err) {
    if (err?.retryable === false) return false;
    const status = err?.response?.status;
    const retryableCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED']);
    return !status || status === 429 || status >= 500 || retryableCodes.has(err?.code);
  }

  _sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Transcribe using OpenAI Whisper API
   */
  async _transcribeOpenAI(buffer, filename, language) {
    if (!this.openaiApiKey) {
      const err = new Error('OpenAI API key not configured');
      err.code = 'WHISPER_NOT_CONFIGURED';
      throw err;
    }

    const fileStream = Buffer.isBuffer(buffer) ? Readable.from(buffer) : buffer;
    const form = new FormData();
    form.append('file', fileStream, {
      filename,
      contentType: this._getContentType(filename),
      knownLength: Buffer.isBuffer(buffer) ? buffer.length : undefined,
    });
    form.append('model', 'whisper-1');
    form.append('language', language);

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${this.openaiApiKey}`,
          },
          timeout: this.transcriptionTimeout,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      return response.data?.text || '';
    } catch (err) {
      const status = err.response?.status;
      const apiMessage = err.response?.data?.error?.message || err.message;
      
      if (status === 401) {
        const err = new Error(`OpenAI authentication failed: ${apiMessage}`);
        err.code = 'WHISPER_AUTH';
        throw err;
      }
      
      const wrapped = new Error(`OpenAI Whisper API error: ${apiMessage}`);
      wrapped.code = 'WHISPER_FAILED';
      throw wrapped;
    }
  }

  /**
   * Get MIME type from filename
   */
  _getContentType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const types = {
      ogg: 'audio/ogg',
      opus: 'audio/opus',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      webm: 'audio/webm',
      flac: 'audio/flac',
    };
    return types[ext] || 'audio/ogg';
  }

  /**
   * Get service status for health checks
   */
  async getStatus() {
    const backend = await this._getBackend();
    return {
      available: this.isAvailable(),
      backend,
      localService: this.useLocalService ? this.transcriptionServiceUrl : null,
      openaiConfigured: Boolean(this.openaiApiKey),
      defaultModel: this.defaultModel,
      defaultLanguage: this.defaultLanguage,
    };
  }
}

module.exports = new VoiceService();
