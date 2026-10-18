# AI API Playground (Local-First MCP Developer Console)

[![Live Demo](https://img.shields.io/badge/Live_Demo-ai--playground.ownyourwebsite.app-6366f1?style=for-the-badge&logo=vercel)](https://ai-playground.ownyourwebsite.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-16.3-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.github/CONTRIBUTING.md)

A developer-first, local-first LLM playground that integrates the Model Context Protocol (MCP) directly into your browser. Configure models, connect remote/hosted MCP servers, trace request/response payloads in raw JSON, and export production-ready snippets in seconds.

## 🚀 Key Features

- **Zero-Backend-Cost (BYOK):** Bring your own LLM keys (OpenAI, Anthropic, Groq, Ollama) or any **Custom Provider** (OpenAI API-compatible endpoints like vLLM, LM Studio, or OpenRouter) and GitHub Personal Access Tokens (PAT).
- **Human-in-the-loop (HITL):** All MCP tool calls require manual user approval before execution, ensuring full control over what actions the LLM takes on your behalf.
- **GitHub Write Mode:** Toggle write actions (create/update/delete) for the GitHub MCP to save prompt tokens and fit within lower-tier model limits.
- **Dynamic Provider & Model Selection:** Define custom model strings for any popular provider, or add entirely custom Base URLs directly in the settings. The UI dynamically detects your configured keys and offers them as selectable models without manual toggling.
- **Local-First / Private:** All keys, prompt templates, and chat histories are stored inside your browser's **IndexedDB**. Keys are held in memory and forwarded per-request to the model provider — they are never persisted server-side.
- **Key Remembering & Expiry:** Secrets can stay session-only; timestamped top-level API keys and the GitHub PAT expire after 30 days unless their fields are saved again. Legacy keys without expiry and saved custom-provider keys are not automatically expired.
- **Real-time Streaming & Metrics:** Smooth stream processing for all providers. Track estimated token usage (including MCP schema overhead) and API latency in real-time.
- **Local Attachments:** Preview UTF-8 text/source files and PNG/JPEG/WebP images before sending. Image-support hints are optional and dismissible, never permission gates; the provider decides whether to accept images. Provider charges/quotas still apply. See [attachment limits and safety](docs/attachments.md).
- **Hosted MCP Presets (GitHub):** Wire up the official hosted GitHub copilot MCP endpoint (`https://api.githubcopilot.com/mcp/`) natively using your GitHub PAT.
- **Custom remote MCPs:** Proxy JSON-RPC requests safely using an SSRF-shielded HTTP proxy.
- **Developer Diagnostics:** Inspect exact raw payload requests and stream responses. Export fully-typed TypeScript (Vercel AI SDK) and curl commands instantly.

---

## 🛠️ Setup Instructions

### 1. Run the App Locally

Use Node.js **22.23.3**, pinned in [.node-version](.node-version), and install the locked dependency versions:

```bash
npm ci
cp .env.example .env.local   # optional: configure environment variables (see below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the workspace.

#### Deploy your own instance on Vercel

1. Fork this repository, then import your fork into Vercel as a Next.js project. Use the repository root and the default build/output settings; select Node.js **22.x**.
2. Provider keys are entered in the application's Settings, not committed or added as deployment secrets. For a public instance, configure the optional hosting variables from [the environment example](.env.example): supply both Upstash Redis credentials, set `RATE_LIMIT_REQUIRED=1`, and keep `RATE_LIMIT_FAIL_OPEN=0`. Never enable `ALLOW_PRIVATE_MCP` on a public deployment.
3. Deploy, open your new URL and configure your providers. Review the [hosting security guidance](.github/SECURITY.md#hosted-deployments--token-passthrough) before accepting other users' keys. Dependency audit results and abuse protections need a separate review; a successful build is not a security certification.

Chats and keys belong to the browser and origin where they were saved; they do not automatically transfer from localhost or the demo to your deployment. The recovery import transfers backed-up chats/files, not provider keys. A hosted instance also cannot reach Ollama on your computer through its own localhost.

### 2. Enter API Keys (BYOK)

1. Click **Settings** in the bottom-left corner.
2. Configure a **Custom Provider** (Base URL, API Key, Model ID) for any OpenAI-compatible API, or expand **Popular Providers** to set keys and override default model IDs for:
   - **OpenAI** (`sk-...`)
   - **Anthropic** (`sk-ant-...`)
   - **Groq** (`gsk_...`)
   - **Ollama** (defaults to local `http://127.0.0.1:11434/api`)
3. **Remember keys on this device** defaults on and stores secrets as plain text in IndexedDB. Turn it off to keep secrets in this tab only; saved provider definitions remain, without their keys. Expiry is checked on load, not a background deletion timer. Saving a top-level key field refreshes its 30-day timestamp; older keys without a timestamp are preserved. Saved custom-provider keys have no per-key expiry.

### 3. Connect GitHub MCP

1. Switch to the **MCP Servers** tab on the right sidebar.
2. In the **GitHub Integration** preset card:
   - Generate a read-only fine-grained GitHub PAT by clicking the provided link out to [GitHub Settings](https://github.com/settings/personal-access-tokens/new).
   - To safely limit blast radius, grant only **Contents (read)** and **Metadata (read)** scopes. For write actions, grant **Contents (write)**, **Issues (write)**, and **Pull Requests (write)**.
   - Paste your PAT into the token field.
3. Click **Connect**.
4. Once connected, all available GitHub tools (like `get_me`, `get_file_contents`, etc.) will load instantly!
5. Optional: Toggle **GitHub Write Mode** in the server settings to filter out non-read tools, keeping your prompt context small and avoiding rate limits on smaller models.

### 4. Bring Your Own MCP (Custom Remote Servers)

Connect **any** remote MCP server — not just the built-in GitHub preset — by
adding it directly in the right sidebar.

1. Switch to the **MCP Servers** tab on the right sidebar.
2. In the **Add Remote MCP Server** form (it stays pinned above your custom
   servers, so it's always reachable):
   - Give the server a **Name** (e.g. `Tavily Search`).
   - Paste the server's **URL** — a Streamable HTTP or SSE endpoint
     (e.g. `https://mcp.tavily.com/mcp`).
   - Add whatever **headers** that server's docs require, commonly
     `Authorization: Bearer <your-key>`. Use **"+ Add header"** to add more than
     one (e.g. an API key header plus a version header).
3. Click **Add Remote Server**, then **Connect**. Once connected, the server's
   tools load and become available to the agent.
4. Edit or delete any custom server later using the pencil / trash icons on its
   card — changes are saved locally in your browser.

> **Example:** Tavily's remote MCP (`https://mcp.tavily.com/mcp`) works with a
> single `Authorization: Bearer <your Tavily key>` header. This is just one
> example among many — the app is intentionally vendor-neutral, so you can plug
> in any Streamable HTTP / SSE MCP server.

> **Security note:** MCP tool output is **untrusted content**. The model should
> treat tool results as data, never as instructions. Review tool arguments
> before approving, and only connect servers you trust.

### 5. Interactive Chat & Safety

1. Start a new chat session.
2. When the LLM decides to use a tool, it will enter a **"Needs Approval"** state.
3. Review the tool arguments and click **Confirm & Run** to execute the tool or **Deny** to cancel.
4. Use the **Manual Tool Runner** in the right sidebar to test individual tools with custom JSON arguments before using them in the agentic loop.

#### Background work, recovery, and local saving

- Hiding a browser tab does not cancel an in-progress model response or an approved tool. Unapproved tools continue waiting for your decision, including after reloading.
- **Stop**, switching chats, or leaving the page stops client-side waiting. A remote write may already have completed: **Outcome unknown** means verify the repository before proposing another write. Model Retry never automatically replays an MCP operation.
- Stream errors distinguish response-length limits, content filtering, malformed streams, timeouts, and incomplete responses. Partial text and received tool results remain visible.
- If IndexedDB cannot save, you can continue and switch chats in temporary mode. Unsaved snapshots stay in this tab; **Retry saving** retries chats/settings and reports whether anything remains unsaved. **Download unsaved chats** creates a validated v2 recovery copy with full attachment payloads and no provider credentials. Missing files or recovery limits prevent the download rather than creating an incomplete backup. Closing/reloading the tab can lose unsaved changes; a browser warning is best-effort, not a backup.
- **Restore backup** is always available in Settings and beside the download action in the storage warning. Select a JSON recovery backup (v1 text-only or v2, **32 MiB maximum**, including base64/whitespace), review chat/message/attachment counts, then explicitly **Import**. Cancel writes nothing. Import atomically creates new copies, leaves original chats, RAM-only chats and settings unchanged, imports no keys and runs no models/tools. Unfinished work in the copies is marked interrupted. Success does not switch chats or disturb the current response/draft; **View restored chat** is an optional, explicit switch.
- Settings show saving errors instead of reporting success. Keep the same browser origin (scheme, host, and port) and browser profile: changing ports or switching between localhost and 127.0.0.1 uses a different local database. A failed read does not prove deletion. If an upgrade is blocked, close other tabs/windows using that address and retry; do not clear site data. Restarting the development server does not itself delete browser data.
- Model replies support CommonMark and GitHub-flavored Markdown. Raw HTML is not executed and remote images are not loaded. User-selected image attachments are separate local previews, not remote Markdown images.
- Retry/restart/Clear actions appear at the bottom of chat history, including in short chats, and hide while scrolling up without covering messages.

### 6. Attach Text Files and Images

Use **Add attachments** beside the message field, preview or remove files, then send with or without a text message. Text is read locally; images are sent as real multimodal input, not just filenames. Nothing is sent during selection/preview.

- Privacy, limits and API costs appear on the first paperclip click; confirmation is remembered in this browser for this site. Reopen the notice anytime with the adjacent **Attachment information** button. Dismissal alone does not acknowledge it.
- Selected files appear as equal compact tiles inside the composer, above the message, in one left-aligned row of up to four. One file never stretches to fill the row. Open a tile for a separate local preview without resizing the composer; close with Escape, the close button or a backdrop click. Each tile has its own remove button and the toolbar shows the file count.
- Up to **4 files**, **256 KiB per text file**, **1 MiB per image**, **2 MiB per message**, and **4 MB per complete request**, including history and base64. No silent truncation.
- Choose an image-capable model. Custom/Ollama/unknown IDs and known text-only IDs may show a compact, dismissible hint, remembered for that endpoint/model without API keys. No compatibility checkbox or client-side support gate blocks sending, retrying or continuing historical images. The provider can reject the input; files are never dropped. Format, byte limits and missing-payload checks still apply.
- Private image previews use browser-local blob URLs, preserve aspect ratio and never pass through the Next.js image optimizer. Text previews still show the first 2,000 characters; full contents are sent.
- Saved payloads live in a separate IndexedDB store. Temporary-mode recovery downloads include unsaved file payloads; never close the tab before saving or downloading them.
- Ollama uses its OpenAI-compatible **/v1** chat-completions endpoint; an existing native **/api** URL is normalized automatically. A local vision model and a running Ollama are still required; a hosted app cannot reach Ollama on your computer through its own localhost.
- PDF/DOCX/OCR, animated images, and attachment-aware code snippet export are **not** included in this version. The inspector explicitly redacts file contents; its diagnostic copy is not a replayable request. Full behavior, privacy, and limitations: [attachment guide](docs/attachments.md).

---

## 🧠 Reasoning Accordion

When a model "thinks" before answering, that hidden reasoning is surfaced in the
**Thought process** accordion above each assistant reply. It is collapsed by
default and shows a live _"Thinking…"_ placeholder while it is still streaming.

The accordion is fed from two sources:

1. **Reasoning blocks embedded in the text** of local / OpenAI-compatible models
   (e.g. Ollama). Tags such as `<think>`, `<thinking>`, `<reasoning>`, and
   `<thought>` are parsed client-side, stripped from the visible answer, and
   shown under the accordion instead — with a fallback if a tag opens but never
   closes.
2. **Dedicated reasoning stream deltas** from hosted reasoning models — Claude
   adaptive thinking, OpenAI reasoning models, and Groq's Qwen3 thinking. These
   deltas are rendered only inside the accordion and never appear in the main
   answer body.

Reasoning content never bleeds into the main reply — the visible answer always
stays clean.

---

## 🎯 Skills

Skills are reusable instruction presets / prompt templates shown in the left
sidebar with an icon. Four built-in skills are seeded on first run:

| Skill         | Icon        |
| ------------- | ----------- |
| Repo Explorer | folder-tree |
| Code Reviewer | code        |
| Debugger      | bug         |
| Data Analyst  | database    |

Clicking a skill opens an editable instruction preview and a **"use GitHub MCP"**
toggle. **Apply** places the instructions into the input box for your next
message. You can create custom skills (choose a name, an icon including
sparkles, instructions, and an optional GitHub MCP toggle) and delete custom
ones. Everything is stored locally in IndexedDB via `getSkills` / `saveSkill` /
`deleteSkill`.

---

## ⚙️ Environment Variables

For **local development**, all environment variables are optional — the app works out of the box with an empty `.env.local`. Public deployments must configure abuse protection; see [`.env.example`](.env.example) for placeholders and the [security guidance](.github/SECURITY.md#rate-limiting-and-trusted-proxies) for the trust boundary.

| Variable                     | Default   | Description                                                                                                                                                                                                                                                       |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_PRIVATE_MCP`          | _(empty)_ | Set to `1` **only for local development** to allow `http://` URLs and private/localhost MCP servers through the SSRF-shielded proxy (and to allow a local Ollama URL on hosted deployments). **Never enable this on a publicly deployed instance** (e.g. Vercel). |
| `UPSTASH_REDIS_REST_URL`     | _(empty)_ | Base HTTPS Upstash REST URL, without `/pipeline` or `/multi-exec`. With both credentials empty and `RATE_LIMIT_REQUIRED=0`, rate limiting is disabled for local use.                                                                                              |
| `UPSTASH_REDIS_REST_TOKEN`   | _(empty)_ | Upstash Redis REST token (kept server-side only).                                                                                                                                                                                                                 |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `20`      | Chat requests per 60-second window, per trusted IP or shared bucket.                                                                                                                                                                                              |
| `RATE_LIMIT_MCP_PER_MINUTE`  | `60`      | MCP proxy requests per 60-second window, per trusted IP or shared bucket.                                                                                                                                                                                         |
| `RATE_LIMIT_REQUIRED`        | `0`       | Set to `1` on public deployments: absent/incomplete Redis credentials then produce HTTP 503 instead of silently disabling protection.                                                                                                                             |
| `RATE_LIMIT_FAIL_OPEN`       | `0`       | Configured Redis failures return 503 by default. `1` explicitly permits requests during Redis failures; not recommended for public use. Invalid configuration still fails closed.                                                                                 |
| `RATE_LIMIT_IP_HEADER`       | _(empty)_ | Operator-selected header containing **one IP**, overwritten by a trusted edge. No header means one shared bucket per scope; visitor forwarding headers are ignored.                                                                                               |
| `RATE_LIMIT_TIMEOUT_MS`      | `2000`    | Absolute Redis deadline including response body, in milliseconds; positive integer up to 10000.                                                                                                                                                                   |

> **Rate limiting** uses one atomic Upstash REST transaction for the counter and TTL, with no extra npm dependencies or automatic retries. The 60-second window starts with the first request and is not extended by later requests. Quota exhaustion returns **429** with the remaining window in `Retry-After`; Redis failures return **503** by default. Invalid/incomplete configuration is never silently accepted. All attempts consume quota, including requests later rejected by the handler.

> **Public deployment:** set `RATE_LIMIT_REQUIRED=1`, provide both Redis credentials and leave `RATE_LIMIT_FAIL_OPEN=0`. Without `RATE_LIMIT_IP_HEADER`, all users share the chat/MCP limits separately. For per-IP quotas, choose a header only after verifying that your proxy/hosting edge **overwrites** it with one actual client IP and the origin cannot be reached directly. Comma-separated forwarding chains and missing/invalid selected headers are rejected with 503. The application cannot verify that your reverse proxy is trustworthy; rate limiting does not replace access control or edge-level abuse protection.

> **Ollama URL protection:** on hosted deployments (detected via the `VERCEL` environment variable) a custom Ollama base URL must pass the same SSRF checks as MCP servers — it must be a public HTTPS endpoint. Locally this restriction does not apply, so `http://127.0.0.1:11434/api` keeps working out of the box. If you self-host on a VPS behind a reverse proxy and want the same protection there, restrict `/api/chat` bodies or set up equivalent network-level guards.

---

## 📚 Documentation

- **[Attachment Guide](docs/attachments.md)** - Supported files, limits, privacy and recovery
- **[Contributing Guide](.github/CONTRIBUTING.md)** - Development, testing and pull requests
- **[Code of Conduct](.github/CODE_OF_CONDUCT.md)** - Our community standards
- **[Security Policy](.github/SECURITY.md)** - Reporting vulnerabilities and hosting safely

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](.github/CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⭐ Showcase

If you build something cool with this tool, please let us know! Open an issue or submit a PR to be featured here.

🌐 Brought to you by Own Your Website
This playground is an open-source tool built and maintained by OwnYourWebsite - empowering developers and businesses with ready-to-deploy web solutions, embedded AI architectures, and full code ownership.

Main Ecosystem: ownyourwebsite.app

Live Playground: ai-playground.ownyourwebsite.app
