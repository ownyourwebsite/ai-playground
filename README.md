# AI API Playground (Local-First MCP Developer Console)

[![Live Demo](https://img.shields.io/badge/Live_Demo-ai--playground.ownyourwebsite.app-6366f1?style=for-the-badge&logo=vercel)](https://ai-playground.ownyourwebsite.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-16.3-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A developer-first, local-first LLM playground that integrates the Model Context Protocol (MCP) directly into your browser. Configure models, connect remote/hosted MCP servers, trace request/response payloads in raw JSON, and export production-ready snippets in seconds.

## 🚀 Key Features

*   **Zero-Backend-Cost (BYOK):** Bring your own LLM keys (OpenAI, Anthropic, Groq, Ollama) or any **Custom Provider** (OpenAI API-compatible endpoints like vLLM, LM Studio, or OpenRouter) and GitHub Personal Access Tokens (PAT).
*   **Human-in-the-loop (HITL):** All MCP tool calls require manual user approval before execution, ensuring full control over what actions the LLM takes on your behalf.
*   **GitHub Write Mode:** Toggle write actions (create/update/delete) for the GitHub MCP to save prompt tokens and fit within lower-tier model limits.
*   **Dynamic Provider & Model Selection:** Define custom model strings for any popular provider, or add entirely custom Base URLs directly in the settings. The UI dynamically detects your configured keys and offers them as selectable models without manual toggling.
*   **Local-First / Private:** All keys, prompt templates, and chat histories are stored inside your browser's **IndexedDB**. Keys are held in memory and forwarded per-request to the model provider — they are never persisted server-side.
*   **Real-time Streaming & Metrics:** Smooth stream processing for all providers. Track estimated token usage (including MCP schema overhead) and API latency in real-time.
*   **Hosted MCP Presets (GitHub):** Wire up the official hosted GitHub copilot MCP endpoint (`https://api.githubcopilot.com/mcp/`) natively using your GitHub PAT.
*   **Custom remote MCPs:** Proxy JSON-RPC requests safely using an SSRF-shielded HTTP proxy.
*   **Developer Diagnostics:** Inspect exact raw payload requests and stream responses. Export fully-typed TypeScript (Vercel AI SDK) and curl commands instantly.

---

## 🛠️ Setup Instructions

### 1. Run the App Locally
```bash
npm install
cp .env.example .env.local   # optional: configure environment variables (see below)
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to view the workspace.

### 2. Enter API Keys (BYOK)
1. Click **Settings** in the bottom-left corner.
2. Configure a **Custom Provider** (Base URL, API Key, Model ID) for any OpenAI-compatible API, or expand **Popular Providers** to set keys and override default model IDs for:
    *   **OpenAI** (`sk-...`)
    *   **Anthropic** (`sk-ant-...`)
    *   **Groq** (`gsk_...`)
    *   **Ollama** (defaults to local `http://127.0.0.1:11434/api`)
3. Optional: Enable **Remember keys on this device** to persist keys inside your IndexedDB.

### 3. Connect GitHub MCP
1. Switch to the **MCP Servers** tab on the right sidebar.
2. In the **GitHub Integration** preset card:
    *   Generate a read-only fine-grained GitHub PAT by clicking the provided link out to [GitHub Settings](https://github.com/settings/personal-access-tokens/new).
    *   To safely limit blast radius, grant only **Contents (read)** and **Metadata (read)** scopes. For write actions, grant **Contents (write)**, **Issues (write)**, and **Pull Requests (write)**.
    *   Paste your PAT into the token field.
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

---

## ⚙️ Environment Variables

All environment variables are **optional** — the app works out of the box with an empty `.env.local`. See [`.env.example`](.env.example) for placeholders.

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOW_PRIVATE_MCP` | _(empty)_ | Set to `1` **only for local development** to allow `http://` URLs and private/localhost MCP servers through the SSRF-shielded proxy. **Never enable this on a publicly deployed instance** (e.g. Vercel). |
| `UPSTASH_REDIS_REST_URL` | _(empty)_ | Upstash Redis REST endpoint. If both Upstash variables are empty, rate limiting is fully disabled. Create a free database at [upstash.com](https://upstash.com) → Redis → REST API details. |
| `UPSTASH_REDIS_REST_TOKEN` | _(empty)_ | Upstash Redis REST token (kept server-side only). |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `20` | Chat requests per minute per IP. |
| `RATE_LIMIT_MCP_PER_MINUTE` | `60` | MCP proxy requests per minute per IP. |

> **Rate limiting** activates automatically as soon as both Upstash variables are set — no code changes needed. It is implemented against the Upstash REST API with zero extra npm dependencies and **fails open** if Redis is unreachable. For public deployments (e.g. Vercel), enabling it is recommended.

---

## 📚 Documentation

- **[Contributing Guide](CONTRIBUTING.md)** - How to contribute to this project
- **[Code of Conduct](CODE_OF_CONDUCT.md)** - Our community standards
- **[Security Policy](SECURITY.md)** - How to report vulnerabilities

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⭐ Showcase

If you build something cool with this tool, please let us know! Open an issue or submit a PR to be featured here.

🌐 Brought to you by Own Your Website
This playground is an open-source tool built and maintained by OwnYourWebsite - empowering developers and businesses with ready-to-deploy web solutions, embedded AI architectures, and full code ownership.

Main Ecosystem: ownyourwebsite.app

Live Playground: ai-playground.ownyourwebsite.app

