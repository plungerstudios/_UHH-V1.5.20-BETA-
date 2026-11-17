# Changelog

## 1.5.20 (beta) - 2026-11-17

- Added photo attachments for Gemini image understanding.
- Added image generation with Cloudflare Workers AI and FLUX.1 Schnell.
- Added private Supabase Storage for syncing chat photos and generated images across signed-in devices.
- Limited automatic text fallback to Gemini 3.8 Flash and OpenRouter's free-model router.
- Kept potentially billable Mistral and Groq models out of automatic fallback. Pollinations is not used because it spends Pollen credits; image generation shows the requested unavailable message when Cloudflare is unavailable or out of free quota.
- Fixed mobile sidebar layering so its chat controls remain interactive.
- Added version metadata and refreshed privacy and setup guidance.
