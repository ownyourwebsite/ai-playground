# Security Policy

## 🔒 Reporting Security Vulnerabilities

We take the security of AI API Playground seriously. If you discover a security vulnerability, we appreciate your responsible disclosure.

### How to Report

**Please DO NOT report security vulnerabilities through public GitHub issues.**

Use the repository's [Security tab](https://github.com/ownyourwebsite/ai-playground/security) and **Report a vulnerability** when private reporting is available. If it is not available, contact the maintainers through the contact options on [their GitHub profile](https://github.com/ownyourwebsite) to arrange a private channel. Do not post exploit details, keys or personal data in a public issue.

### What to Include

When reporting a security vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information for follow-up questions

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Status Updates**: Every 2 weeks until resolution

### Disclosure Policy

- We will work with you to understand and resolve the issue before any public disclosure
- We will credit you for the discovery (unless you prefer to remain anonymous)
- We will publish a security advisory after the fix is released

## 🛡️ Security Best Practices for Contributors

### API Keys and Secrets

- **Never commit API keys or secrets** to the repository
- Use environment variables for sensitive configuration
- The `.gitignore` file is configured to prevent accidental commits of `.env` files
- Test files should use mock values, not real credentials

### Dependencies

- Regularly update dependencies to patch known vulnerabilities
- Run `npm audit` to check for vulnerable packages
- Review dependency changes in PRs carefully
- CI reports production dependency audit results in a separate, currently non-blocking job. Review its output before public deployment; a passing build or quality job does not establish that all dependency vulnerabilities are resolved.

**Known dependency status (2026-10-18):** the current lockfile reports 9 affected production package entries in `npm audit --omit=dev`: 1 critical, 4 high and 4 moderate. The critical classification includes the pinned Next.js version. These are dependency-audit findings, not proof that every advisory is exploitable in this application, but this snapshot is **not cleared for an untrusted public deployment**. Review the current advisory details, apply compatible fixes and rerun all checks before opening your instance to other users. The synchronization did not change dependency versions beyond those already used by the demo.

### User Data

- This application stores data locally in the user's browser (IndexedDB)
- Sending a message forwards its text, selected files and relevant chat history to the chosen model provider through the application's server; approved MCP calls send their arguments to the connected MCP server
- Provider keys and MCP credentials pass through the hosting server to the selected endpoint; the app does not add a server-side credential or chat database
- Keys saved with "Remember keys on this device" are stored **unencrypted** in IndexedDB — anyone with access to the browser profile can read them
- Follow privacy-by-design principles in all contributions

### Hosted Deployments & Token Passthrough

The app is BYOK (Bring Your Own Key): API keys and GitHub PATs are entered by
users in their browser and forwarded per-request. When using a **hosted
instance** (e.g. the public demo), these credentials transit through that
instance's server:

- LLM keys are sent as request headers to `/api/chat` and forwarded to the
  chosen provider.
- MCP credentials (e.g. a GitHub PAT) are sent in proxied request headers via
  `/api/mcp` and forwarded to the MCP server.

If you operate a hosted instance, you are trusted with this traffic:

- **Disable access-log logging of request headers** on your platform/CDN.
- Do not add instrumentation that records `x-*-key` or `Authorization` headers.
- Say so explicitly in your deployment's privacy notice.

Self-hosting (fork + deploy your own instance) avoids this trust entirely and
is recommended for sensitive tokens.

## 📋 Security-Related Configuration

### Environment Variables

Copy the [environment example](../.env.example) to a local environment file, or configure its hosting variables in your deployment dashboard. Do not commit local environment files. Provider API keys are configured in the browser's Settings, not through server environment variables.

### Rate Limiting and Trusted Proxies

- Local forks can run without Redis only when both credentials are empty and `RATE_LIMIT_REQUIRED` is unset or `0`. On public deployments, set `RATE_LIMIT_REQUIRED=1` and provide the base HTTPS Upstash REST URL and write-capable token.
- Configured Redis failures, malformed responses and deadlines return **503** by default. Keep `RATE_LIMIT_FAIL_OPEN=0` publicly. Setting it to `1` deliberately permits requests during Redis failure; it never bypasses missing credentials or invalid configuration.
- The limiter uses an atomic `/multi-exec` transaction for `INCR`, `EXPIRE NX` and `TTL`. It validates every command result and does not retry uncertain increments. Transactions provide isolation, not rollback on command errors; the failed request is rejected and a later healthy transaction can restore a missing TTL.
- Each scope has a first-request-anchored 60-second window. Without `RATE_LIMIT_IP_HEADER`, all visitors share one bucket per scope; client-supplied `x-forwarded-for` and `x-real-ip` are ignored. This can let one visitor exhaust the shared budget, so configure a verified identity boundary or add edge-level protections before public use.
- For per-IP quotas, explicitly select one header that the trusted edge **overwrites** with exactly one valid IP. Reject or strip visitor-supplied values, block direct origin access and verify your hosting platform's actual header contract. The application does not infer trusted proxies or choose the first IP in an arbitrary forwarding chain. Missing/invalid selected headers fail closed.
- `RATE_LIMIT_TIMEOUT_MS` is a deadline for the entire Redis request including body reading. Quota exhaustion is **429**, not **503**, with a `Retry-After` derived from the remaining TTL. These limits protect application requests, not upstream tokens, spend, user authentication or traffic reaching the hosting edge.

### Content Security Policy

This repository does not configure a custom Content Security Policy. Review and configure appropriate security headers for your deployment, and validate them when modifying endpoints or adding external resources. Do not assume framework defaults provide a complete CSP.

## 🔐 Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## 📚 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Next.js Security Best Practices](https://nextjs.org/docs/going-to-production)
- [GitHub Security Documentation](https://docs.github.com/en/code-security)

---

Thank you for helping keep AI API Playground secure! 🔒
