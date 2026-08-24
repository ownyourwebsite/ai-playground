# Security Policy

## 🔒 Reporting Security Vulnerabilities

We take the security of AI API Playground seriously. If you discover a security vulnerability, we appreciate your responsible disclosure.

### How to Report

**Please DO NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **[INSERT SECURITY EMAIL ADDRESS]**

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

### User Data

- This application stores data locally in the user's browser (IndexedDB)
- No user data is sent to external servers
- API keys are only transmitted to the respective AI provider APIs
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

Copy `.env.example` to `.env.local` and configure as needed:

```bash
# Example .env.local structure (DO NOT commit this file)
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
```

### Content Security Policy

The application uses standard Next.js security headers. If you modify API endpoints or add external resources, ensure CSP compliance.

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
