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
- Follow privacy-by-design principles in all contributions

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
