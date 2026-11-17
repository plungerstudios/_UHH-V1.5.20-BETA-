# _UHH by Plunger Studios

**Version 1.5.20 (beta).** _UHH is a chat website powered by a Python AI backend. Verified email-link sign-in lets each user sync chats and images across browsers and devices. A local IndexedDB copy is also kept in each browser.

## What users need to know

- Sign-in sends a one-time email link through Supabase Auth. The user must open the link to verify the email. It is not Google OAuth and does not ask users for a password.
- Signed-in chat text is stored in the project's Supabase database; attached and generated images are stored in a private Supabase Storage bucket. Both sync to that user's other signed-in devices. Personalization settings remain local to each browser.
- Text replies try Gemini 3.8 Flash, then OpenRouter's `openrouter/free` router. Photo understanding uses Gemini 3.8 Flash. Image generation uses Cloudflare Workers AI with FLUX.1 Schnell. Supabase and AI providers process data under their own current policies. The service owner can access stored chat history and images.
- Provider API keys belong in Render's private environment settings. Never include them in the Windows app, GitHub, a `.env` file committed to Git, or chat. The Supabase anon/publishable key is public configuration; never use or expose a Supabase `service_role`/secret key in the app.
- The app uses Google's free-tier Gemini 3.8 Flash and OpenRouter's free-only router. Their free quotas and availability can change; Google's free tier may use submitted data to improve products. Mistral Large and the requested Groq models are excluded because free API use is not verified; they may incur charges. Pollinations is excluded because image requests spend Pollen credits.
- Cloudflare Workers AI currently includes a 10,000-Neuron daily free allocation. On a Cloudflare free plan, image requests stop when the allocation is exhausted. Keep the Cloudflare account on its free plan to avoid paid overages; a paid Workers plan can bill usage. If Cloudflare is unavailable or out of quota, _UHH shows `uhh looks like i cant generate photos right now` and does not fall back to a paid image service.
- Basic per-IP and per-account rate limits are included, but they cannot prevent all abuse or protect provider quotas. Set provider spending limits/disable billing where possible; don't publish the endpoint until you understand this risk.
- Render's free services may sleep when idle, so the first reply can be slow. Free plans and quotas are not guaranteed and may change.

## Set up Supabase chat sync

1. Create a Supabase project.
2. In its SQL Editor, run the contents of [`supabase_schema.sql`](./supabase_schema.sql). It creates the chat table, a private `chat-images` Storage bucket, and row-level security so each account can access only its own rows and images. If your project restricts the Data API to selected tables, expose `public.chat_histories` in the API settings.
3. In Supabase Auth settings, enable email sign-in. Under URL Configuration, set the Site URL to your Render URL and add these Redirect URLs:
   - `https://your-service-name.onrender.com/**`
   - `http://localhost:8000/**` (needed for the local Windows app)
4. Configure an SMTP sender before public release; Supabase's default email sender has low sending limits.

## Publish the website on Render

1. Put this project in a GitHub repository. Do not add `.env`, provider keys, or `backend_url.txt`.
2. In Render, create a Blueprint from the repository and select the included `render.yaml`. It creates one web service for both the website and AI API.
3. In the service's Environment settings, add:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_ANON_KEY` — the public anon/publishable key from Supabase API settings
   - `GEMINI_API_KEY` — your Google AI Studio key (Gemini 3.8 Flash is selected automatically)
   - `OPENROUTER_API_KEY` — optional key for the `openrouter/free` text fallback
   - `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` — Cloudflare credentials for FLUX.1 Schnell image generation; use a free Workers plan and a token with Workers AI access
4. Deploy and wait for Render to show the service as live. Add its URL to Supabase Auth's Site URL and Redirect URLs, then use that URL to open _UHH.

The website and API share the same URL. Users need only a verified email link; provider keys stay on Render. The backend tries Gemini 3.8 Flash, then the OpenRouter free router for text. It does not configure Mistral, Groq, or Pollinations because their requested services are not verified as free. When all text providers are unavailable, the app shows the outage notice and polls provider status without generating test prompts.

## Run _UHH locally on Windows

1. Install Python 3.
2. Copy `backend_url.example.txt` to `backend_url.txt` and replace its contents with your Render URL. Alternatively, copy `.env.example` to `.env` and set `UHH_BACKEND_URL`.
3. Double-click `run.bat`. It starts the local app and opens `http://localhost:8000`.

For local development, the same backend URL can be set in `.env`. Do not put provider keys or Supabase service-role keys there; the local app does not need them. Add `http://localhost:8000/**` to the Supabase Auth Redirect URLs for email-link sign-in.

## Build a runnable Windows app

1. Complete the Render deployment and create `backend_url.txt` with the website URL.
2. Install Python 3 and PyInstaller: `python -m pip install pyinstaller`
3. Double-click `build_windows.bat`.
4. Share `dist\_UHH.exe` (and the copied `backend_url.txt` next to it) with users. The executable contains no provider API keys. Users sign in with their verified email and sync chat text and photos through Supabase.

The executable launches the local app in the default browser. It uses `http://localhost:8000`, so that browser origin keeps its own local cache and syncs chat text and photos with the signed-in Supabase account. Keep the executable's console window open while using _UHH.

## Accounts and chat data

- A one-time email link verifies the account. Supabase stores chat text under the signed-in user ID, protected by row-level security, and photos in that user's private Storage folder; each browser also keeps a local copy. Clearing browser data removes only that local copy.
- On the first sign-in on a browser with older local chats, _UHH asks before uploading them. Chats attached to another signed-in user on that device are not included.
- Photo attachments are sent to Gemini for understanding. Generated prompts and output images are sent to Cloudflare Workers AI. Chat context is sent to the selected AI provider. Do not upload sensitive photos or enter sensitive information.

## Terms and privacy

The app presents the Terms of Use & Privacy Notice supplied for _uhh at first launch. That notice is an app-provided summary, not legal advice. Review provider and hosting terms and update the notice before public release.

The site includes a web app manifest. Browsers that support installation may offer an option to install _UHH from the browser menu.
