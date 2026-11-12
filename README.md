# SmartCare (React + Node.js + Express + MongoDB + Razorpay)

OPD token and queue management. The React/Vite UI talks to an Express API backed by MongoDB.
Online token fees are paid through **Razorpay** (UPI, cards, net banking).

```
smartcare_react/
├─ src/, index.html, vite.config.js   React/Vite shell
├─ public/legacy/                     the SmartCare UI (api.js = API client, script.js = screens, chatbot.js, qr.js)
└─ server/                            Express + Mongoose API
   └─ src/{config,models,services,routes,middleware}
```

## One-command automation (`npm run auto`)

```bash
npm run auto          # setup (only what is missing) + start website, API and AI agents
npm run auto:setup    # only prepare: .env files, packages, Python agents, MongoDB (Docker)
npm run doctor        # health check + live test of your Groq key
npm run docker:up     # whole project in Docker (MongoDB + web/API + agents), http://localhost:5000
```

What `npm run auto` does for you, every time and safely (it never overwrites values you already set):

- creates `server/.env` and `agents/.env` if missing, with a generated `JWT_SECRET`, agent seed phrase and a random staff password (printed once, saved in `server/.env`); uses the practice payment mode until you add Razorpay keys
- adds any new settings from `.env.example` that your `.env` is missing
- installs the npm packages, creates `agents/.venv` and installs the Python agents (skipped if Python is missing)
- starts MongoDB with Docker when `MONGODB_URI` points to localhost and nothing is running there
- copies `GROQ_API_KEY` from `server/.env` to `agents/.env`, so the key lives in one place
- starts web (5173), API (5000) and agents (8000) together; Ctrl+C stops all of them

Flags: `--skip-install`, `--no-agents`, `--no-mongo` (example: `npm run auto -- --no-agents`).

## AI answers for any question (out-of-syllabus)

The chatbot answers hospital questions from its rules + `kb.json`, and **everything else with an LLM** (Groq, free):

1. Get a free key at https://console.groq.com/keys and put it in `server/.env` as `GROQ_API_KEY=...`
2. Restart (`npm run auto`). The agents copy the key automatically. Check with `npm run doctor`.

Routing: questions not about SmartCare/health (e.g. "capital of France", "explain recursion") go straight to the AI; SmartCare questions
use the rules/KB first; if the AI is off, the bot falls back to the TinyFish web search. The AI remembers the last few turns of the chat,
never diagnoses or suggests medicines, and sends emergencies to 108/112.

## Groq AI (GroqCloud)

1. Free key: https://console.groq.com/keys
2. In `server/.env` set `GROQ_API_KEY=gsk_...` (optional: `GROQ_MODEL`, default `openai/gpt-oss-120b`)
3. `npm run auto` (or restart the API). `npm run doctor` confirms the key works.

Where Groq is used:

| Where | What it does |
| --- | --- |
| Chatbot, `POST /api/chat/ask` | Answers questions the built-in rules cannot, grounded on `public/legacy/kb.json`. Patients can also type `ai <question>`. Order: agent, then Groq, then TinyFish web search. |
| Triage agent | Picks the department for unclear symptoms. Red-flag emergencies are always decided by the keyword rules and never by the LLM. |
| Knowledge agent | Grounded "how does SmartCare work" answers. |

Groq is optional. With no key everything keeps working on rules (and ASI:One if `ASI1_API_KEY` is set, used as backup when Groq fails). The key stays on the server; the browser never sees it.

## Quick start

Needs Node 18.18+ and a MongoDB (local, Docker or Atlas).

```bash
npm run setup                      # installs the web app and the server
docker compose up -d               # optional: local MongoDB   (or use an Atlas URI)
cp server/.env.example server/.env # then edit it (see below)
npm run dev:all                    # web: http://localhost:5173   api: http://localhost:5000
```

On first start the server creates the 15 default departments and one staff account from
`ADMIN_USERNAME` / `ADMIN_PASSWORD` in `server/.env`. Staff screens (Admin, Counter Booking, Departments,
OPD Status, Analytics, Emergency, Scan QR) ask for that login. Reset the password later with
`npm run seed -- --reset-admin` after changing `ADMIN_PASSWORD`.

### `server/.env`

| Variable | Notes |
|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/smartcare` or your Atlas `mongodb+srv://...` |
| `JWT_SECRET` | 16+ random characters (server refuses to start otherwise) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first staff account (password 8+ chars) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | from the Razorpay dashboard. **Use `rzp_test_...` keys while developing** |
| `RAZORPAY_WEBHOOK_SECRET` | secret you choose when creating the webhook (below) |
| `RESERVATION_MINUTES` | how long a token is held while the patient pays (default 10) |

## Demo payment mode (no Razorpay account needed)

Set this in `server/.env` and restart the server:

```
PAYMENT_MODE=demo
```

Paid departments then open a **practice payment window** (choose UPI / Card / Net Banking, then *Pay*,
*Simulate failed payment* or *Cancel*). No real money is charged and Razorpay is never contacted, so the
Razorpay keys can stay empty. Booking, token, receipt, queue, notifications, counter booking, refunds and
reports all work as usual. Demo mode is **ignored when `NODE_ENV=production`**; remove the line (or set
`PAYMENT_MODE=razorpay`) and add real keys to switch to Razorpay. The demo window skips the signature and
webhook checks, so test those with Razorpay test keys before going live.

## Payments (Razorpay)

1. Create a free Razorpay account and copy the **Test Mode** key id and secret into `server/.env`.
2. Restart the server. Booking a department with a fee now opens Razorpay Checkout.
   In test mode use Razorpay's test UPI id `success@razorpay`, or test card `4111 1111 1111 1111`
   (any future expiry, any CVV, OTP `1234` if asked). No real money moves.
3. **Webhook (recommended, required in production).** It issues the token even if the patient's
   browser closes right after paying. Dashboard → Settings → Webhooks → URL
   `https://<your-domain>/api/payments/webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`, events
   `payment.captured`, `order.paid`, `payment.failed`. For local testing expose port 5000 with a tunnel (ngrok / cloudflared).
4. Going live: swap in `rzp_live_...` keys and complete Razorpay KYC.

How a paid booking works:

1. `POST /api/bookings/online` reserves one of the department's online tokens, creates a Razorpay order
   (amount comes from the department fee on the server, never from the browser) and returns the order.
2. The browser opens Checkout. Card/bank details go to Razorpay only.
3. `POST /api/payments/verify` checks the HMAC signature, re-fetches the payment from Razorpay, checks the
   amount and order, then issues the token. The webhook does the same job; both are idempotent
   (unique indexes) so a token is never issued twice.
4. Closing Checkout releases the reserved token (`/payments/cancel`); unpaid reservations also expire after
   `RESERVATION_MINUTES`. If money arrives after a reservation expired, a slot is taken again, or the payment is
   refunded automatically when the day's tokens are gone.

## Production

```bash
npm run build           # builds the React app into dist/
npm run server:start    # the API also serves dist/ (same origin, no CORS needed)
```
Set `NODE_ENV=production`, a strong `JWT_SECRET`, `TRUST_PROXY=1` behind nginx/Render/Railway, and use HTTPS.

## API

Public
| Method | Path | |
|---|---|---|
| GET | `/api/health` | status of API, DB, payment mode (`demo` / `razorpay`) |
| GET | `/api/departments` | departments with fee, room, tokens left (online/counter), now serving, waiting |
| GET | `/api/queue?department=<id>` | today's live queue (token, room, department, status, time; **no personal data**) |
| GET | `/api/queue/token/:token` | one token: position, estimated time, room, receipt summary |
| GET | `/api/notifications?token=GM-048` | broadcasts + messages for that token |
| POST | `/api/bookings/online` | `{name, age, phone, departmentId}` → free: ticket · paid: Razorpay order |
| POST | `/api/payments/verify` | `{orderId, paymentId, signature}` → ticket |
| POST | `/api/payments/cancel` | `{orderId}` release reservation |
| GET | `/api/payments/status/:orderId` | has the webhook issued the token yet |
| POST | `/api/payments/webhook` | Razorpay → server (signature-checked, raw body) |
| POST | `/api/auth/login` | `{username, password}` → JWT |

Staff (`Authorization: Bearer <jwt>`)
| Method | Path | |
|---|---|---|
| GET | `/api/auth/me` | |
| POST / PUT / DELETE | `/api/departments[/:id]` | add / edit (name, room, daily tokens, fee) / remove |
| PATCH | `/api/departments/:id/status` | OPD `Available` / `Busy` / `Unavailable` (notifies patients) |
| POST | `/api/admin/counter-bookings` | `{departmentId, mode: Cash\|UPI\|Card}` issue a counter (offline) parcha |
| GET | `/api/admin/payments?day=YYYY-MM-DD` | fee collections |
| POST | `/api/admin/payments/:id/refund` | Razorpay refund (or manual record for counter payments) + cancels the token |
| GET | `/api/admin/stats` | overview + analytics numbers |
| POST | `/api/admin/queue/checkin` | `{token}` call a patient (QR scan) |
| PATCH | `/api/admin/queue/:token/status` | Waiting / Consultation / Completed / Cancelled |
| POST | `/api/admin/emergency` | `{token}` or `{departmentId}` (new emergency token, bypasses quota) |

## Behaviour worth knowing

- **70/30 quota** is enforced atomically in MongoDB, so two patients can never take the last online token.
  Token numbers (`GM-001`…) are per department per day and reset at midnight IST.
- Patient name/age/phone are stored but never returned by any public endpoint.
- No MongoDB transactions are used, so a standalone `mongod` works (no replica set needed).
- The chatbot now sends booking requests to the booking page (it can no longer mint a token on its own).
- The UI refreshes queue screens every 10 seconds; new notifications appear as toasts.
- Not included: SMS/WhatsApp delivery of notifications (the phone number is collected for that).




# SmartCare – Hospital Management System

SmartCare is a hospital management system built using React/Vite, Node.js, Express.js and MongoDB.

## Technologies

* Frontend: React / Vite
* Backend: Node.js + Express.js
* Database: MongoDB
* Authentication: JWT
* Payment: Demo Mode

## Requirements

Install these before running the project:

* Node.js
* MongoDB
* VS Code (recommended)

## 1. Extract the ZIP

Extract the project ZIP anywhere on your computer.

Open the extracted `smartcare_react` folder in VS Code.

## 2. Install Dependencies

Open the VS Code terminal and run:

```bash
npm run setup
```

This installs both frontend and backend dependencies.

## 3. Create Environment File

Create the file `server/.env` by copying `server/.env.example`:

```bash
copy server\.env.example server\.env      # Windows   (macOS/Linux: cp server/.env.example server/.env)
```

Then set `JWT_SECRET` to any long random text and uncomment `PAYMENT_MODE=demo`.

Example contents:

Example:

```env
NODE_ENV=development
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
TRUST_PROXY=0

MONGODB_URI=mongodb://127.0.0.1:27017/smartcare

JWT_SECRET=change-this-to-a-long-random-secret
JWT_EXPIRES_IN=8h

ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe@123
ADMIN_NAME=Staff

PAYMENT_MODE=demo

RESERVATION_MINUTES=10
AVG_CONSULT_MIN=6
ONLINE_SHARE=0.7
AUTO_SEED=true
```

## 4. Make Sure MongoDB Is Running

On Windows, make sure the MongoDB service is running.

You can check it using PowerShell:

```powershell
Get-Service MongoDB
```

It should show:

```text
Status: Running
```

## 5. Create/Reset Staff Login

From the project root:

```bash
npm run seed -- --reset-admin
```

This creates/resets the staff account using the username and password from `.env`.

## 6. Start the Project

Run:

```bash
npm run dev:all
```

This starts both:

* Frontend: http://localhost:5173
* Backend: http://localhost:5000

## 7. Open the Website

Open:

```text
http://localhost:5173
```

## Staff Login

```text
Username: admin
Password: ChangeMe@123
```

## Important

Do not share the `.env` file publicly because it may contain passwords, JWT secrets or API keys.

For sharing the project, include `.env.example` instead.

## If the project does not start

First make sure MongoDB is running.

Then run:

```bash
npm run setup
```

and:

```bash
npm run seed -- --reset-admin
```

Finally:

```bash
npm run dev:all
```

## Chatbot web search (TinyFish)

The patient chatbot answers app questions (tokens, queue, departments, rooms) with its own rules. For anything else,
or when a patient types `search <question>`, it asks the server, which calls the TinyFish Search API and returns up to
4 links with snippets.

- Set `TINYFISH_API_KEY` in `server/.env` (key from https://agent.tinyfish.ai/api-keys) and restart the server.
- Endpoint: `POST /api/chat/search` `{ "q": "..." }` (public, limited to 8 requests/minute per IP).
- The key never reaches the browser. With no key set, the chatbot works exactly as before.

## AI agents (Fetch.ai uAgents, Agentverse, ASI:One)

`/agents` adds a multi-agent layer on top of the SmartCare API for the Fetch-A-Thon 3.0 hackathon.

```
Patient / ASI:One ──chat protocol──▶ Concierge agent ──▶ Triage agent   symptoms -> department + urgency (rules, optional ASI:One LLM)
Web chatbot ─▶ Express /api/agent/chat ─▶ (REST)   │ ──▶ Queue agent    live queue, rooms, wait time, token status
                                                   └───▶ Booking agent  reserves the token (asks before any fee)
                                      all three call the existing SmartCare REST API
```

Run it (Python 3.10+):

```bash
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
npm run agents:setup                                      # pip install -r agents/requirements.txt
cp agents/.env.example agents/.env                        # set AGENT_SEED_PHRASE; USE_MAILBOX=false for local-only
echo "AGENT_URL=http://localhost:8000" >> server/.env     # lets the web chatbot reach the agent
npm run dev:all                                           # terminal 1: web + api
npm run agents                                            # terminal 2: the four agents (one process)
```

- **Web chatbot:** open the chat bubble and click *Ask AI agent* (or type `agent book appointment for fever`). Questions the rule-based bot cannot answer also go to the agent, then to web search.
- **ASI:One / Agentverse:** keep `USE_MAILBOX=true`. On start the Concierge prints an *Agent inspector* link; open it and click *Connect -> Mailbox* to register it on Agentverse. Then search for "SmartCare Concierge" in ASI:One (agent address is printed at start). Deterministic addresses come from `AGENT_SEED_PHRASE`, so keep it secret and stable.
- **Smarter triage (optional):** put an ASI:One key in `agents/.env` as `ASI1_API_KEY`. Red-flag rules always run first and the LLM can never downgrade an emergency.
- **Payments:** with `PAYMENT_MODE=demo` the agent completes the practice payment after the patient replies YES; with real Razorpay it hands the patient to the web app.
- Each agent also runs alone: `python agents/triage_agent.py`, `queue_agent.py`, `booking_agent.py`, `concierge_agent.py`.

## Chatbot knowledge base

`public/legacy/kb.json` holds 30+ topics (how to book, what to do after registration, payment failed, refunds, OTP, QR / check-in,
queue time, cancel / change, emergency, timings, privacy, staff features, ...). The web chatbot reads it directly and the Python
Concierge agent reads the same file, so both give identical answers. Matching handles English, Hinglish and spelling mistakes; "then?" / "aur?"
continues to the next step; follow-ups like "and its fee?" reuse the last department. To teach the bot something new, add an entry
(`id`, `kw` keyword phrases, `ex` example questions, `a` answer, optional `chips`, `next`) and rebuild with `npm run build`. With
`ASI1_API_KEY` set, questions with no confident match are answered by ASI:One using only the closest entries as facts.
