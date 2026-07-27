# WLPA Bot

**WLPA Bot** is a multilingual Telegram and WhatsApp assistant for questions about India's **Wildlife (Protection) Act, 1972**. It combines legal reference material with Gemini-powered responses, conversation context, and optional voice-message transcription.

> This tool is informational and does not replace advice from a qualified legal professional or wildlife authority.

## Highlights

- Answers wildlife-law questions in English, Hindi, and Marathi
- Supports Telegram polling and webhook delivery
- Receives WhatsApp Cloud API webhooks
- Uses WLPA documents and amendments as retrieval context
- Keeps conversation context for follow-up questions
- Handles scenario-based wildlife queries and incident reporting flows
- Transcribes supported audio messages through a local `faster-whisper` service

## Architecture

```text
Telegram / WhatsApp
        |
        v
Express application (Node.js)
        |
        +--> MongoDB: conversations and application data
        +--> Gemini: response generation
        +--> WLPA assets: legal retrieval context
        +--> Whisper service (optional): voice transcription
```

## Requirements

- Node.js 18 or newer
- npm
- MongoDB, either local or MongoDB Atlas
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Gemini API key

Optional:

- Python 3.12+ with `Flask` and `faster-whisper` for local audio transcription
- WhatsApp Cloud API credentials for WhatsApp integration
- A public HTTPS URL when using Telegram or WhatsApp webhooks

## Quick Start

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create your local configuration file.

   ```powershell
   Copy-Item .env.example .env
   ```

   On macOS or Linux:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and set at least the required values:

   ```dotenv
   MONGODB_URI=mongodb://127.0.0.1:27017/wlpa_bot
   TELEGRAM_BOT_TOKEN=replace_with_your_bot_token
   GEMINI_API_KEY=replace_with_your_gemini_key
   ```

4. Ensure MongoDB is running, then start the bot in development mode.

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000/health` to confirm that the HTTP service is running.

The default Telegram mode is polling (`USE_WEBHOOK=false`), so no public URL is required for a local Telegram setup.

## Voice Transcription

Voice transcription is enabled by default and expects the local service at `http://localhost:5000`.

1. Install the Python dependencies required by `transcription_service/app.py` in your chosen Python environment.
2. Start the service from the project root:

   ```bash
   npm run transcription:dev
   ```

3. Check its health endpoint:

   ```text
   http://localhost:5000/health
   ```

Set `USE_LOCAL_TRANSCRIPTION=false` to disable the local service. You may instead configure `WHISPER_API_KEY` as a fallback transcription provider.

Supported audio formats include OGG, WAV, MP3, M4A, WebM, FLAC, and Opus. The service downloads models into `.whisper_cache/`, which is intentionally ignored by Git.

## Connect Telegram

### Local development: polling

Polling is the simplest way to run the Telegram bot locally. Create a bot through [@BotFather](https://t.me/BotFather), copy its token, then use:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
USE_WEBHOOK=false
```

Start the application with `npm run dev`, open your bot in Telegram, and send a message. No public URL is needed in polling mode.

### Production: webhooks

Webhooks need a public HTTPS URL. Set `WEBHOOK_URL` to the **complete Telegram webhook endpoint**, including `/telegram/webhook`:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
USE_WEBHOOK=true
WEBHOOK_URL=https://bot.example.com/telegram/webhook
```

When the application starts, it registers this URL with Telegram. Telegram then sends updates to:

```text
POST https://bot.example.com/telegram/webhook
```

Do not use a bare domain for `WEBHOOK_URL`; the application sends this exact value to Telegram.

## Connect WhatsApp

WhatsApp integration uses the Meta WhatsApp Cloud API and always receives messages through a webhook.

1. In Meta for Developers, create or select your app and add the WhatsApp product.
2. Copy the access token, phone number ID, app secret, and business account ID into `.env`.
3. Choose a private verification token and use the same value in Meta's webhook configuration.
4. Set `WHATSAPP_WEBHOOK_URL` to your public HTTPS **base URL**.
5. In the Meta dashboard, configure the callback URL and verify it.

Example configuration:

```dotenv
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_WEBHOOK_VERIFY_TOKEN=choose_a_long_private_value
WHATSAPP_APP_SECRET=your_app_secret
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
WHATSAPP_WEBHOOK_URL=https://bot.example.com
```

For the example above, configure this callback URL in Meta:

```text
https://bot.example.com/whatsapp
```

The application uses the following routes:

| Method | Path | Used for |
| --- | --- | --- |
| `GET` | `/whatsapp` | Meta's webhook verification challenge |
| `POST` | `/whatsapp` | Incoming messages and delivery events |

Keep `WHATSAPP_APP_SECRET` private. Incoming webhook signatures are checked with it, so an incorrect value causes the application to reject Meta requests.

## Configuration

Copy `.env.example` to `.env`; it documents every available setting. The most important options are:

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `GEMINI_API_KEY` | Yes | Gemini API key used for answers |
| `PORT` | No | HTTP port; defaults to `3000` |
| `DEFAULT_LANGUAGE` | No | Fallback language: `en`, `hi`, or `mr` |
| `USE_WEBHOOK` | No | Enables Telegram webhooks; defaults to `false` |
| `WEBHOOK_URL` | Webhooks only | Public Telegram webhook base URL |
| `USE_LOCAL_TRANSCRIPTION` | No | Enables local Whisper service; defaults to `true` |
| `TRANSCRIPTION_SERVICE_URL` | No | Local transcription URL; defaults to `http://localhost:5000` |
| `WLPA_PDF_PATH` | No | Path to the Wildlife Protection Act PDF |
| `WHATSAPP_*` | WhatsApp only | WhatsApp Cloud API configuration |

Never commit `.env` or real credentials.

## HTTP Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check; reports MongoDB connection status |
| `POST` | `/telegram/webhook` | Telegram webhook receiver |
| `GET` | `/whatsapp` | WhatsApp webhook verification |
| `POST` | `/whatsapp` | WhatsApp webhook receiver |

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Run the production server |
| `npm run dev` | Run with Nodemon |
| `npm run transcription:dev` | Start the local Python transcription service |
| `npm run lint` | Lint JavaScript under `src/` |
| `npm run docker:build` | Build Docker Compose services |
| `npm run docker:up` | Start Docker Compose services |
| `npm run docker:down` | Stop Docker Compose services |
| `npm run docker:logs` | Follow Docker Compose logs |

## Project Layout

```text
.
├── assets/                    # WLPA source documents
├── src/
│   ├── bot/                   # Telegram integration
│   ├── config/                # Environment and database configuration
│   ├── controllers/           # Webhook and health handlers
│   ├── data/                  # Legal knowledge data
│   ├── models/                # MongoDB/Mongoose models
│   ├── routes/                # Express routes
│   └── services/              # AI, search, voice, and domain services
├── transcription_service/     # Flask and faster-whisper service
├── .env.example               # Configuration template
├── docker-compose.yml         # Container orchestration configuration
└── server.js                  # Application entry point
```

## Docker

`docker-compose.yml` defines the bot, transcription service, and MongoDB services. Before using the Docker commands, make sure the Dockerfiles referenced by the Compose file are available in your checkout and configure the required environment variables in `.env`.

```bash
npm run docker:up
npm run docker:logs
```

## License

MIT
