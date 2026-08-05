# WLPA Bot

WLPA Bot is a multilingual Telegram and WhatsApp assistant for India's **Wildlife (Protection) Act, 1972**. It combines structured legal reference data, official Act and amendment PDFs, fuzzy search, Gemini-generated answers, conversation memory, scenario analysis, incident reporting, and optional voice transcription.

The bot currently supports English, Hindi, and Marathi. It is intended for general information and education; it is not a substitute for advice from a qualified lawyer, forest officer, or other competent authority.

## Contents

- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Local setup](#local-setup)
- [Configuration](#configuration)
- [Run the application](#run-the-application)
- [Telegram integration](#telegram-integration)
- [WhatsApp integration](#whatsapp-integration)
- [Voice transcription](#voice-transcription)
- [Knowledge and answer pipeline](#knowledge-and-answer-pipeline)
- [User features](#user-features)
- [HTTP API](#http-api)
- [Persistence](#persistence)
- [Project structure](#project-structure)
- [Docker](#docker)
- [Scripts](#scripts)
- [Troubleshooting](#troubleshooting)
- [Security and operations](#security-and-operations)
- [Repository status](#repository-status)

## Capabilities

- Answer questions about sections, schedules, species, penalties, procedures, definitions, FAQs, glossary terms, and amendments.
- Search local JSON knowledge sources and pass the most relevant context to Gemini.
- Answer follow-up questions using recent conversation history restored from MongoDB after a restart.
- Detect or remember the user's preferred language and respond in English, Hindi, or Marathi.
- Analyze practical wildlife scenarios and suggest legally informed next steps.
- Generate a structured incident report for situations such as poaching, illegal trade, animal attacks, illegal possession, and human-wildlife conflict.
- Send the main WLPA PDF and the amendment PDFs available in `assets/amendments/` through Telegram.
- Accept Telegram and WhatsApp voice messages when a transcription backend is available.
- Receive Telegram updates through polling or an HTTPS webhook.
- Receive and verify WhatsApp Cloud API webhooks with Meta's verification token and HMAC signature.

## Architecture

```text
Telegram polling/webhook                  WhatsApp Cloud API webhook
          |                                        |
          +------------------+---------------------+
                             v
                    Express application
                             |
          +------------------+------------------+
          |                  |                  |
          v                  v                  v
       MongoDB          Local knowledge      Gemini API
   users, chats,       JSON + WLPA PDFs       answer generation
   memory, WA queue
          |
          v
   faster-whisper service (optional)
```

At startup, `server.js` loads configuration, connects to MongoDB, builds the Express app, initializes Telegram and the local knowledge services, optionally registers webhooks, and starts the HTTP server.

## Requirements

Required for the Node.js application:

- Node.js 18 or newer
- npm
- MongoDB 7 or a compatible MongoDB deployment
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

Optional:

- Python 3.10+ with Flask and `faster-whisper` for local transcription
- OpenAI API access for the Whisper fallback
- WhatsApp Cloud API credentials from Meta for Developers
- A public HTTPS address for Telegram webhook mode or WhatsApp

## Local setup

### 1. Install Node.js dependencies

```bash
npm install
```

### 2. Create the environment file

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

Never commit `.env`; it is ignored by Git.

### 3. Set the required values

At minimum, the application requires all three values below at startup, even when only one messaging platform is being used:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/wlpa_bot
TELEGRAM_BOT_TOKEN=replace_with_your_telegram_token
GEMINI_API_KEY=replace_with_your_gemini_key
```

### 4. Start MongoDB

For a local MongoDB installation, start the MongoDB service and use the URI above. For MongoDB Atlas, replace it with the Atlas connection string and make sure the machine running the bot is allowed by the Atlas network access rules.

### 5. Start the bot

```bash
npm run dev
```

The default HTTP port is `3000`. Check:

```text
http://localhost:3000/health
http://localhost:3000/ready
```

`/health` confirms that the process is alive. `/ready` returns HTTP 200 only when the MongoDB connection is ready.

## Configuration

`.env.example` is the complete configuration template. The application reads configuration from the project-root `.env` file through `src/config/index.js`.

### Core settings

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Runtime environment label. |
| `PORT` | No | `3000` | Express HTTP port. |
| `MONGODB_URI` | Yes | — | MongoDB connection string. |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Token issued by Telegram's BotFather. |
| `GEMINI_API_KEY` | Yes | — | API key used for answer generation. |
| `GEMINI_MODEL` | No | `gemini-1.5-flash` | Gemini model name. |
| `DEFAULT_LANGUAGE` | No | `en` | Fallback language: `en`, `hi`, or `mr`. |
| `CORS_ORIGIN` | No | `*` | CORS origin used by Express. |
| `LOG_LEVEL` | No | `info` | Winston log level; use `debug` only while diagnosing issues. |
| `WLPA_PDF_PATH` | No | `assets/wlpa.pdf` | Main WLPA PDF path. Relative paths resolve from the project root. |

### Telegram settings

| Variable | Required | Description |
| --- | --- | --- |
| `USE_WEBHOOK` | No | `false` uses polling; `true` disables polling and enables webhook delivery. |
| `WEBHOOK_URL` | Webhook mode | Complete public HTTPS URL, including `/telegram/webhook`. |

Polling is the simplest local setup. Webhook mode requires a reachable HTTPS endpoint and a reverse proxy or hosting platform that forwards requests to the Node.js process.

### WhatsApp settings

| Variable | Required | Description |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp only | Meta WhatsApp Cloud API access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp only | Phone Number ID used to send messages. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp only | Private token configured both here and in Meta. |
| `WHATSAPP_APP_SECRET` | WhatsApp production | App secret used to verify `X-Hub-Signature-256`. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Webhook subscription | WhatsApp Business Account ID. |
| `WHATSAPP_WEBHOOK_URL` | Webhook subscription | Public base URL; the application appends `/whatsapp`. |

The WhatsApp route is always webhook-based. The code includes placeholder defaults for some WhatsApp values so the Node process can start without a WhatsApp account, but real WhatsApp traffic requires valid Meta credentials.

### Transcription settings

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `USE_LOCAL_TRANSCRIPTION` | No | `true` | Probe and use the local faster-whisper service first. |
| `TRANSCRIPTION_SERVICE_URL` | No | `http://127.0.0.1:5000` | Base URL of the transcription service. |
| `TRANSCRIPTION_HOST` | No | `127.0.0.1` | Python transcription bind address. |
| `TRANSCRIPTION_PORT` | No | `5000` | Internal Python transcription port; keep separate from Railway's `PORT`. |
| `TRANSCRIPTION_STARTUP_TIMEOUT_SECONDS` | No | `300` | Maximum supervisor wait for Python `/health`. |
| `TRANSCRIPTION_STARTUP_INTERVAL_SECONDS` | No | `2` | Supervisor health-check interval. |
| `WHISPER_MODEL` | No | `base` | Model such as `tiny`, `base`, `small`, `medium`, `large`, `large-v2`, or `large-v3`. |
| `WHISPER_DEVICE` | No | `cpu` | Faster-whisper device. Use `cuda` only with a CUDA-capable image/runtime. |
| `WHISPER_COMPUTE_TYPE` | No | `int8` | Faster-whisper compute type. |
| `WHISPER_CACHE_DIR` | No | platform-dependent | Model cache directory. |
| `WHISPER_LANGUAGE` | No | `en` | Language hint passed to the transcription service. |
| `TRANSCRIPTION_TIMEOUT` | No | `60000` | Request timeout in milliseconds. |
| `TRANSCRIPTION_HEALTH_TIMEOUT` | No | `3000` | Health-check timeout in milliseconds. |
| `TRANSCRIPTION_RETRIES` | No | `3` | Retry attempts for health and local transcription requests. |
| `TRANSCRIPTION_RETRY_DELAY_MS` | No | `1000` | Linear backoff delay between retries. |
| `MAX_FILE_SIZE_MB` | No | `25` | Maximum audio size accepted by the Node service and Flask service. |
| `WHISPER_API_KEY` | No | unset | OpenAI API key used as a fallback when local transcription is unavailable. |

## Run the application

Development mode uses Nodemon:

```bash
npm run dev
```

Production-style mode runs Node directly:

```bash
npm start
```

The application must be started from the project root so relative paths such as `assets/wlpa.pdf` and `src/data/` resolve correctly.

## Telegram integration

### Polling mode

Use polling for local development:

```dotenv
USE_WEBHOOK=false
TELEGRAM_BOT_TOKEN=your_bot_token
```

Start the app with `npm run dev`, open the bot in Telegram, and send `/start`. No public URL is required.

### Webhook mode

Set the complete webhook endpoint:

```dotenv
USE_WEBHOOK=true
WEBHOOK_URL=https://bot.example.com/telegram/webhook
```

On startup, the bot registers this exact URL with Telegram. Telegram sends updates to:

```text
POST /telegram/webhook
```

The route returns HTTP 200 after forwarding the update to the Telegram bot instance. Telegram requests are rate-limited to 120 requests per minute per IP.

### Telegram commands and menus

| Command or action | Behavior |
| --- | --- |
| `/start` | Shows the main help message and menu. |
| `/help` | Shows help and the main menu. |
| `/english` | Sets the user's preferred language to English. |
| `/hindi` | Sets the user's preferred language to Hindi. |
| `/marathi` | Sets the user's preferred language to Marathi. |
| `/scenario` | Opens scenario analysis mode. |
| `/incident` | Starts the guided incident report flow. |
| `/amendments` | Shows amendment information. |
| Main keyboard buttons | Open question, section, species, PDF, language, and about menus. |
| Voice message | Downloads and transcribes the audio before asking Gemini. |

The menu also supports browsing sections, protected species, schedules, PDF choices, amendment PDFs, answer feedback, and language selection through inline keyboard callbacks.

## WhatsApp integration

WhatsApp uses the Meta WhatsApp Cloud API and receives messages through the routes below:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/whatsapp` | Meta webhook verification challenge. |
| `POST` | `/whatsapp` | Incoming messages and delivery/status events. |

### Meta configuration

1. Create or select an app in Meta for Developers and add the WhatsApp product.
2. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_BUSINESS_ACCOUNT_ID`.
3. Choose a long, private `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
4. Set `WHATSAPP_WEBHOOK_URL` to the public base URL, for example `https://bot.example.com`.
5. Configure Meta's callback URL as `https://bot.example.com/whatsapp`.
6. Subscribe the app to the required WhatsApp webhook fields.

When `WHATSAPP_WEBHOOK_URL` and a real business account ID are configured, startup attempts to subscribe the app to the WABA. The application acknowledges valid webhook requests quickly, stores inbound messages in MongoDB, deduplicates Meta message IDs, and processes messages through a per-phone queue.

Supported WhatsApp inputs are text and voice. `/start` and `/help` return a help response; other text is sent through the regular question pipeline. WhatsApp responses are split into chunks when they exceed the platform message limit.

### Signature verification

For production, set a real `WHATSAPP_APP_SECRET`. The POST handler verifies the `X-Hub-Signature-256` HMAC against the raw request body. Invalid signatures receive HTTP 403. The placeholder `test_app_secret` bypasses this check for local/test behavior and must not be used in production.

## Voice transcription

The Node `VoiceService` uses this backend order:

1. Local faster-whisper service, when `USE_LOCAL_TRANSCRIPTION=true` and its health endpoint responds.
2. OpenAI Whisper API, when `WHISPER_API_KEY` is configured.
3. A user-facing configuration error when neither backend is available.

### Start the local service

Create a Python environment and install the service dependencies:

```bash
python -m venv .venv
```

PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r transcription_service/requirements.txt
```

macOS/Linux:

```bash
source .venv/bin/activate
pip install -r transcription_service/requirements.txt
```

Start the service from the project root:

```bash
npm run transcription:dev
```

The service listens on port `5000` by default. Verify it with:

```text
http://127.0.0.1:5000/health
http://127.0.0.1:5000/models
```

The transcription endpoint is `POST /transcribe` with multipart field `audio`. It accepts OGG, WAV, MP3, M4A, WebM, FLAC, and Opus files. Optional form fields are `language`, `model`, `vad_filter`, and `beam_size`.

The first request or startup preload downloads the selected model. On Windows, models are cached in the project-local `.whisper_cache/` directory; this directory is ignored by Git.

## Knowledge and answer pipeline

Text and transcribed voice questions follow the same high-level flow:

1. Resolve the user's language from an explicit preference, command, or detected text.
2. Load the user's recent conversation context from memory or MongoDB.
3. Search the local knowledge indexes with exact, synonym, and fuzzy matching.
4. Add amendment-specific material when the question concerns a WLPA amendment.
5. Analyze scenario-style questions when the wording describes a real-world situation.
6. Build a constrained prompt containing the question, language, context, and legal disclaimer requirements.
7. Call Gemini and return the formatted answer.
8. Persist the question, answer, language, model, source, and metadata.

Knowledge sources are stored in `src/data/`:

- `sections.json` — Act sections
- `schedules.json` — schedules and categories
- `species.json` — protected species information
- `penalties.json` — offences and penalties
- `procedures.json` — procedures and practical guidance
- `definitions.json` — legal definitions
- `faq.json` — frequently asked questions
- `glossary.json` — domain terminology
- `synonyms.json` — query expansion terms
- `incident_patterns.json` — scenario and incident patterns
- `amendments.json` — amendment history and comparisons

The official document assets are `assets/wlpa.pdf` and the amendment PDFs in `assets/amendments/`.

## User features

### Conversation memory

The bot keeps a short-term in-memory history for responsive follow-ups and stores durable conversation turns in MongoDB. After a process restart, recent turns can be restored for the user.

### Scenario analysis

Users can invoke `/scenario` or describe a practical situation in normal language. The scenario service identifies incident-like questions and adds structured analysis to the Gemini context.

### Incident reports

`/incident` starts a guided, in-memory report flow. It collects:

- Incident type
- Location
- Species involved
- Date and time
- Description
- Witnesses
- Photos or evidence
- Action taken

The completed report is formatted so the user can forward it to the Forest Department. Active incident reports are held in process memory and are lost if the Node process restarts.

### PDFs and amendments

Telegram users can download the main Act PDF, all configured amendment PDFs, or a selected amendment. The currently mapped amendment years are `1982`, `1986`, `1991`, `1993`, `2002`, `2006`, and `2022`.

## HTTP API

### Health and readiness

`GET /health` always returns a liveness response similar to:

```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-08-03T12:00:00.000Z"
}
```

`GET /ready` reports MongoDB readiness. It returns HTTP 200 when connected and HTTP 503 otherwise.

### Webhooks

- `POST /telegram/webhook` — Telegram update receiver; used only when `USE_WEBHOOK=true`.
- `GET /whatsapp` — Meta verification challenge.
- `POST /whatsapp` — Meta webhook receiver with signature verification and asynchronous message processing.

All other routes return a JSON 404 response. Express also enables Helmet, CORS, compression, JSON parsing with a 10 MB limit, request logging, and rate limiting.

## Persistence

MongoDB stores the following models:

| Model | Purpose |
| --- | --- |
| `User` | Telegram or WhatsApp identity, preferred language, and activity timestamps. |
| `ChatMessage` | Durable user-to-bot interactions, including text/voice metadata and Gemini model. |
| `Conversation` | Individual user/assistant turns used to restore conversational context. |
| `WhatsAppInboundMessage` | Durable WhatsApp message queue, status, retry count, and deduplication. |
| `WhatsAppPhoneLock` | Short lease preventing concurrent processing for one WhatsApp phone number. |

## Project structure

```text
.
├── assets/
│   ├── wlpa.pdf                 # Main Wildlife (Protection) Act PDF
│   └── amendments/              # Amendment PDFs
├── src/
│   ├── bot/                     # Telegram bot initialization and handlers
│   ├── config/                 # Environment loading and MongoDB connection
│   ├── controllers/            # Health, Telegram, and WhatsApp controllers
│   ├── data/                   # Searchable legal and domain knowledge
│   ├── middleware/             # Logging and error handling
│   ├── models/                 # Mongoose schemas
│   ├── routes/                 # Express route definitions
│   ├── services/               # Gemini, search, memory, PDF, voice, and domain logic
│   └── utils/                  # Constants, messages, keyboards, and logging
├── transcription_service/
│   ├── app.py                  # Flask faster-whisper microservice
│   └── requirements.txt        # Python production dependencies
├── docker/
│   └── start.sh                # Single-container process supervisor
├── Dockerfile                  # Railway single-container image
├── .dockerignore               # Docker build context exclusions
├── .env.example                # Environment template
├── docker-compose.yml          # Compose configuration
├── package.json                # Scripts and dependencies
└── server.js                   # Node.js entry point
```

## Docker

Railway uses the root `Dockerfile` and runs both application processes in one container:

- Node.js listens on Railway's `PORT` value.
- Faster-whisper listens internally on `127.0.0.1:5000`.
- `docker/start.sh` starts Python first, waits for `/health`, and then starts Node.js.

Build and run locally:

```bash
docker build -t wlpa-bot .
docker run --rm --env-file .env -e PORT=8080 -p 3000:8080 wlpa-bot
```

The image does not copy `.env`; pass secrets at runtime. The first startup downloads the configured Whisper model into `/opt/whisper_cache`. Use a persistent Railway volume for that path if you want to avoid downloading the model after every redeploy.

### Required single-container variables

```dotenv
PORT=8080
TRANSCRIPTION_SERVICE_URL=http://127.0.0.1:5000
TRANSCRIPTION_HOST=127.0.0.1
TRANSCRIPTION_PORT=5000
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
```

`TRANSCRIPTION_SERVICE_URL` is normalized from `localhost` or `::1` to `127.0.0.1` by `VoiceService`, so existing Railway variables using `http://localhost:5000` do not resolve to IPv6 loopback.

`docker-compose.yml` remains as an optional legacy local multi-container setup. It is not used by Railway and is not required for the single-container deployment.

The legacy Compose commands are:

```bash
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
```

The legacy Compose file still expects a separate `transcription_service/Dockerfile`; use the root Dockerfile for the supported Railway single-container deployment.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the Node.js application. |
| `npm run dev` | Start the application with Nodemon. |
| `npm run transcription:dev` | Start `transcription_service/app.py`. |
| `npm run transcription:build` | Build the transcription Docker image. |
| `npm run transcription:run` | Start the Compose transcription service. |
| `npm run docker:build` | Build Compose services. |
| `npm run docker:up` | Start Compose services in the background. |
| `npm run docker:down` | Stop Compose services. |
| `npm run docker:logs` | Follow Compose logs. |
| `npm run lint` | Run ESLint for `src/`. |
| `npm test` | Run Jest integration tests configured under `tests/integration`. |
| `npm run test:watch` | Run the integration tests in watch mode. |
| `npm run test:coverage` | Run integration tests with coverage. |
| `npm run db:seed` | Run `scripts/seed-db.js` when that script is present. |

## Troubleshooting

### `Missing required environment variable`

Copy `.env.example` to `.env` and set `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, and `GEMINI_API_KEY`. The configuration loader fails fast when any required value is missing.

### MongoDB connection failure

Confirm that MongoDB is running, the URI points to the correct database, and Atlas network access allows the current IP. Check `/ready` after startup.

### Telegram bot does not respond

For local development, confirm `USE_WEBHOOK=false` and that no other process is polling the same bot token. For webhook mode, confirm that `WEBHOOK_URL` is the complete HTTPS endpoint and that the reverse proxy forwards `POST /telegram/webhook` to port `3000`.

### WhatsApp verification fails

The value sent by Meta as `hub.verify_token` must exactly match `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Configure the callback URL as `/whatsapp`, not just the domain.

### WhatsApp messages return HTTP 403

Set `WHATSAPP_APP_SECRET` to the Meta app secret. A wrong secret or a request body modified by a proxy causes HMAC verification to fail. Do not disable signature checks in production.

### Voice messages are unavailable

Check `http://127.0.0.1:5000/health`, confirm `USE_LOCAL_TRANSCRIPTION=true`, and verify that `TRANSCRIPTION_SERVICE_URL` matches the service address. If using the fallback, set `WHISPER_API_KEY` and restart the Node process.

### PDFs are not sent

Run the application from the project root and verify that `WLPA_PDF_PATH` exists. Amendment files must use the filenames mapped in `src/services/PDFService.js` and be located under `assets/amendments/`.

## Security and operations

- Keep `.env`, API keys, bot tokens, app secrets, and MongoDB credentials out of Git and logs.
- Use HTTPS for every production webhook endpoint.
- Use a real WhatsApp app secret; `test_app_secret` bypasses signature verification.
- Restrict `CORS_ORIGIN` in production instead of leaving it as `*` when browser clients are involved.
- Put the Express server behind a reverse proxy with TLS termination, request limits, and process supervision.
- Monitor `/health`, `/ready`, application logs, MongoDB connectivity, and transcription model memory usage.
- Keep the legal data and PDFs reviewed when the Act or its amendments change.
- Treat generated answers as informational and verify time-sensitive legal conclusions with an authoritative source.

## Repository status

The repository includes the Node.js source, legal data, PDFs, Python transcription service, and the root Dockerfile used by Railway. The legacy Compose transcription command still references a separate `transcription_service/Dockerfile`; it is not needed for the supported single-container deployment. The package scripts also reference integration tests and a database seed script that are not present in the current checkout. The `lint` script is present, but ESLint is not declared in `package.json`, so provide it in the development environment before running that command.

## License

Copyright (c) 2026 Wildlife Conservation Trust (WCT)
All rights reserved.
