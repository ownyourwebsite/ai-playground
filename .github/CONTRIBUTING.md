# Contributing to AI API Playground

Thank you for your interest in contributing to AI API Playground! This document provides guidelines and instructions for contributing.

## 🚀 Getting Started

1. **Use the CI runtime** - Node.js 22.23.3, pinned in [the runtime file](../.node-version).
2. **Install locked dependencies** - `npm ci`
3. **Create a branch** - `git checkout -b feature/your-feature-name`

## 📋 Development Workflow

### Running the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

### Code Style

- We use ESLint for code linting. Run `npm run lint` to check your code.
- Follow the existing code style and conventions.
- Use TypeScript for all new code.
- Write meaningful commit messages.

### Testing

- Run `npm test` for unit and local regression tests. Test and specification files are discovered recursively under `src/` and `scripts/`; new tests do not need to be added to a manual list.
- Use names such as `feature.test.ts`, `component.test.tsx`, or `feature.spec.ts`. The discovery runner also supports JavaScript and module-specific extensions; it does not follow symbolic links.
- Before fixing a defect, add a regression test that fails on the existing implementation, then verify it passes after the fix. Avoid tests that require real API keys or perform writes to external MCP servers in ordinary CI.
- Runner discovery itself is covered by [the discovery tests](../scripts/run-tests.test.mjs).
- The [chat browser runner](../scripts/chat-browser.mjs) runs separately via `npm run test:chat-browser`. It requires a running local Next.js server plus an existing Playwright/Chromium installation; browser dependencies are not bundled or installed by this command. Set `CHAT_BROWSER_BASE_URL` to the loopback server. An external installation can be selected with `CHAT_PLAYWRIGHT_MODULE`, `CHAT_CHROMIUM_PATH` and, if needed, `CHAT_BROWSER_LIBRARY_PATH`. `CHAT_BROWSER_MODE` labels the report; it does not start or switch the server. Set `CHAT_BROWSER_FILTER` to a scenario-name regular expression for a focused run, or `CHAT_BROWSER_SCREENSHOT_DIR` to save composer screenshots outside the source tree. Run against both development StrictMode and a production build. Fixtures use isolated browser contexts, synthetic credentials and local provider/MCP responses, not working keys or remote writes. Browser tests verify local control flow and SDK conversion, not a real model's image understanding or a deployment's security boundary.

### Required Local Checks and CI

Run the same checks as CI before submitting a change:

```bash
npm run check
```

This runs ESLint, route type generation and TypeScript checks, all discovered tests, then a production build. Each part can also be run separately with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

The [CI workflow](workflows/ci.yml) runs on pushes and pull requests and can be started manually. It installs dependencies from [the lockfile](../package-lock.json) with `npm ci`, uses read-only repository permissions, and does not require provider or MCP credentials. Actions are pinned to immutable commit revisions. Configuring the quality job as a required branch-protection check is a separate repository setting.

Production dependencies are also checked with `npm audit --omit=dev`. **This report is informational and does not currently block the quality checks.** Audit failures are shown in the workflow log and summary; a green quality job does not mean the application is safe for public deployment. Review applicable advisories before hosting publicly. Make dependency auditing blocking when advisories have been fixed or narrowly documented exceptions have been reviewed; see the [dependency guidance](SECURITY.md#dependencies).

These checks do not replace browser E2E, real provider/MCP compatibility tests, Redis integration checks, or deployment security validation.

### Pull Request Process

1. Update documentation if needed.
2. Ensure `npm run check` passes and review the dependency-audit report.
3. Create a Pull Request with a clear title and description.
4. Link any related issues in your PR description.
5. Wait for review from maintainers.

## 🐛 Reporting Bugs

When reporting bugs, please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)
- Environment details (OS, browser, Node.js version)

## 💡 Suggesting Enhancements

Enhancement suggestions are welcome! Please provide:

- Clear description of the enhancement
- Use cases and benefits
- Possible implementation approach (if you have ideas)

## 📝 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 📧 Questions?

Feel free to open an issue for any questions about contributing.

Thank you for contributing! 🎉
