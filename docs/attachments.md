# Local attachments — first version

## Scope and costs

Text/source files, Markdown, CSV and JSON are decoded as UTF-8 in the browser. PNG, JPEG and WebP are sent as real image parts through the model provider's multimodal API. PDF, DOCX, OCR, SVG and GIF are rejected explicitly; no file is silently dropped or truncated. Text does not require a special file-reading model capability. Images require a vision-capable endpoint and model.

No hosted storage account or paid upload service is used. Local reading/previewing is free. Provider inference, extracted text, images and repeated conversation history may consume paid tokens or free quotas. Local Ollama avoids an external inference bill but requires appropriate hardware and a compatible vision model.

## User flow

1. Select **Add attachments**. The first click shows a privacy/limits/cost notice above the paperclip on desktop, or a compact modal on mobile. **Got it, choose files** records acknowledgement for this site/browser and opens the picker immediately; later clicks open the picker directly. The adjacent **Attachment information** button always reopens the notice without opening a picker. Closing, cancelling or pressing Escape does not acknowledge it. Acknowledgement survives reloads but resets when browser site data is cleared; blocked local storage falls back to this tab without blocking selection. This notice is separate from the advisory image-support hint. Choose up to four files; selection and previews do not send a network upload.
2. Review compact, equal-size file tiles in the top-left of the message composer. The four-column row stays horizontal on desktop and narrow mobile screens, without stretching a single file across the composer. Tiles show a thumbnail or text-file icon, filename, decoded-byte size and a remove button; the toolbar shows the current count out of four. Open a tile for a separate, keyboard-accessible local preview that leaves the composer size and typed draft unchanged. Escape, the close button or a backdrop click closes it and restores focus. Long text previews show only the first 2,000 characters; the full text is sent.
3. Remove unwanted files before sending. A rejected batch leaves existing draft files and the typed message intact.
4. Unknown or known text-only image support may show a compact, dismissible hint. No compatibility checkbox or client-side model gate is required. Dismissal is remembered for that endpoint/model without keys or URL credentials. The provider decides whether the input is supported; files are never silently removed.
5. Send with Enter or Send, with or without a text question. All files are sent together or the request is rejected. Follow-up turns, model retries and explicit turn restarts retain file references; they do not duplicate stored payloads or automatically replay MCP writes.
6. Historical file cards load a local preview only when opened. A missing local payload blocks the entire request; the question is never sent without its file.

The action toolbar sits in history, not over it: short chats retain actions, while scrolling up hides the toolbar without changing layout.

## Limits

| Limit                                                    | Value             |
| -------------------------------------------------------- | ----------------- |
| Files per user message                                   | 4                 |
| Each decoded UTF-8 text file                             | 256 KiB           |
| Each PNG/JPEG/WebP image                                 | 1 MiB             |
| Image dimensions, browser check                          | 16 million pixels |
| Text question plus decoded files per message             | 2 MiB             |
| Complete UTF-8 JSON request, history and base64 included | 4,000,000 bytes   |

These are application limits, not the model's token/context limits. Base64 adds overhead. Earlier files are included in later context and may cause the request limit to be reached. Start a new chat or select smaller files; the app does not silently remove context, compress images or truncate files. A deployment/proxy/provider may impose stricter limits.

The browser checks extension, size, UTF-8 decoding, binary/control content and image decoding/signatures. The server independently bounds request reading and checks count/metadata/actual byte sizes, canonical base64 and raster signatures. Network image URLs are not accepted. Server signatures are not a full raster decoder; the pixel-count check is browser-side, not a server guarantee.

## Storage and recovery

IndexedDB upgrades older versions to version 4 and repairs missing/incorrect indexes without deleting stored records or replacing settings, existing conversations or MCP configuration. A healthy newer schema is not downgraded, and an unfamiliar primary key fails safely instead of rebuilding a store. Messages contain only attachment metadata/IDs. Payloads are stored separately and atomically with the referencing session; repeated checkpoints verify small metadata keys rather than rereading or rewriting file contents. Deleting a saved session deletes its own payloads atomically, not another chat's files. Clear Chat starts a new chat and retains the old saved session and its files in the sidebar.

If saving fails, explicitly staged payloads and dirty conversations stay in this tab's RAM. Generation and session switching remain available. **Retry saving** retries chats/settings and reports remaining errors; **Download unsaved chats** creates a validated version-2 recovery JSON containing dirty session snapshots and all uniquely referenced attachment payloads, without provider credentials. Missing payloads or exceeded recovery limits make export fail explicitly rather than producing an incomplete backup.

**Restore backup** in Settings or the storage warning validates a recovery JSON (v1 text-only or v2 with files, up to 32 MiB), previews counts, and requires explicit **Import**. One atomic transaction adds new copies with new IDs, never overwrites existing chats/files/settings, imports no keys and starts no models or tools. Failed imports roll back; successful imports do not switch chats or discard a current draft. Unfinished operations in restored history become interrupted, not automatically resumed.

Draft files are not persisted before sending. Leaving/reloading can lose drafts or unsaved data; the unload warning is best effort. Browser storage is origin/port-specific and can be cleared or evicted by the browser. Saved files are not encrypted by this app. Explicitly staged files stay in RAM for this tab's recovery; historical previews do not fill an unbounded payload cache.

An uncertain local transaction acknowledgement is reconciled against exact stored metadata/bytes before retrying, without overwriting an immutable file ID. This is local persistence reconciliation, never an MCP tool replay.

## Privacy and safety

On Send, full text/image data goes through the application's chat server to the selected provider. Later messages normally resend those files as part of history. No server-side file store is added, but the hosting platform and provider have their own request handling/retention policies. Original image bytes are preserved, including any embedded metadata; remove sensitive metadata before attaching. Avoid uploading private code, credentials or documents unless intended.

Uploaded file contents are untrusted data, not system instructions or permission to execute tools. MCP still requires explicit approval. This prompt-level separation cannot eliminate model prompt injection: review every proposed tool call and its arguments before approving.

The inspector replaces attachment content with an explicit redaction marker while showing metadata. It is not a replayable wire copy. Code snippet export is explicitly disabled for attachment conversations until it can include real payloads; no apparently runnable text-only request is generated by silently omitting files.

## Provider behavior

Native OpenAI/Anthropic/Groq image hints use small exact verified model-ID lists. Unknown IDs remain unknown; names are not matched by broad heuristics. These lists are advisory, never a send gate. An advertised image modality does not guarantee account access, model availability or context capacity. Recognized provider refusals distinguish image incompatibility from unavailable models/endpoints without displaying private upstream responses.

Custom endpoints use the OpenAI-compatible **/chat/completions** API (images as `image_url` data URLs), the API that vLLM, LM Studio, OpenRouter, llama.cpp and similar servers implement. Custom and Ollama image support stays unknown, without requiring explicit compatibility opt-in.

Ollama uses the installed AI SDK 6-compatible OpenAI chat-completions adapter, replacing the incompatible SDK V1 adapter. Native **/api** and root URLs normalize to **/v1**; explicit **/v1** is retained. Production SSRF restrictions remain in force (`ALLOW_PRIVATE_NETWORK=1` lifts them for a self-hosted instance). Real Ollama inference still depends on the user's local installation; localhost on a hosted server is not the user's computer.

## Verification

Unit/integration coverage includes schema migration/repair, atomic commit/delete/import rollback, missing/conflicting payloads, per-session isolation, one-time payload writes, failed/uncertain saves and recovery, Unicode/BOM preservation, malformed/oversized requests, advisory image support, safe provider errors and complete multimodal SDK conversion.

Browser scenarios use fresh contexts, fake credentials, intercepted MCP traffic and a loopback provider. They cover first-use notice acknowledgement/dismissal, reloads, blocked notice storage, keyboard focus and mobile layout, one-to-four compact tiles at widths from 320 to 1440 pixels, light/dark themes, local preview dialogs and blob-URL cleanup, rejection without draft loss, file-only turns, save/reload/delete, unknown and unsupported vision, real browser-to-route-to-SDK image/text delivery, recovery export/import and blocking incomplete requests. No paid provider or real GitHub write is required.

Run the unit, integration and browser checks described in the [contributing guide](../.github/CONTRIBUTING.md#testing). Local provider fixtures verify SDK wire conversion, not a model's ability to understand an image. Real provider compatibility, Ollama inference and deployment security require separate validation; tests never need working provider keys or a real GitHub write.
