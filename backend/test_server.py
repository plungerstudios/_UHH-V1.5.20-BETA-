import base64
import unittest
import json
import os
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

import server


def provider(name):
    return {"name": name, "key": name.lower() + "-test-key", "model": name.lower() + "-test-model", "kind": "openai"}


class ProviderFallbackTests(unittest.TestCase):
    def setUp(self):
        self.providers = [provider("Gemini"), provider("Groq"), provider("OpenRouter")]
        server._cooldowns.clear()
        server._health_cache.update({"at": 0.0, "value": None})

    def test_tries_providers_in_order_until_one_succeeds(self):
        with patch.object(server, "provider_settings", return_value=self.providers), patch.object(
            server,
            "provider_reply",
            side_effect=[
                server.ProviderFailure("Gemini", "quota", True, True),
                "A working answer",
            ],
        ) as reply:
            result = server.complete_chat([{"role": "user", "content": "Hello"}], "Be helpful.", "casual")

        self.assertEqual(result, ("A working answer", "Groq"))
        self.assertEqual([call.args[0]["name"] for call in reply.call_args_list], ["Gemini", "Groq"])

    def test_reports_outage_only_when_all_providers_are_unavailable(self):
        failure = server.ProviderFailure("provider", "rate limited", True, True)
        with patch.object(server, "provider_settings", return_value=self.providers), patch.object(
            server, "provider_reply", side_effect=[failure, failure, failure]
        ):
            with self.assertRaises(server.AllProvidersUnavailable):
                server.complete_chat([{"role": "user", "content": "Hello"}], "", "casual")

    def test_does_not_bypass_a_safety_refusal_with_provider_fallback(self):
        with patch.object(server, "provider_settings", return_value=self.providers), patch.object(
            server, "provider_reply", side_effect=server.SafetyRefusal()
        ) as reply:
            with self.assertRaises(server.SafetyRefusal):
                server.complete_chat([{"role": "user", "content": "Unsafe request"}], "", "casual")
        reply.assert_called_once()

    def test_invalid_key_is_not_misreported_as_quota_outage(self):
        failure = server.ProviderFailure("provider", "invalid key", True, False)
        with patch.object(server, "provider_settings", return_value=self.providers), patch.object(
            server, "provider_reply", side_effect=[failure, failure, failure]
        ):
            with self.assertRaises(server.ProviderConfigurationError):
                server.complete_chat([{"role": "user", "content": "Hello"}], "", "casual")

    def test_previous_model_messages_remain_in_chat_context(self):
        messages, instruction, mode = server.clean_chat_payload({
            "messages": [
                {"role": "user", "content": "First"},
                {"role": "model", "content": "Earlier reply"},
                {"role": "user", "content": "Next"},
            ],
            "systemInstruction": "Be clear.",
            "mode": "expert",
        })

        self.assertEqual([message["role"] for message in messages], ["user", "assistant", "user"])
        self.assertEqual(messages[1]["content"], "Earlier reply")
        self.assertEqual((instruction, mode), ("Be clear.", "expert"))

    def test_default_provider_chain_uses_only_free_text_routes(self):
        with patch.dict(os.environ, {
            "GEMINI_API_KEY": "gemini-test-key",
            "OPENROUTER_API_KEY": "openrouter-test-key",
            "OPENROUTER_MODEL": "a-paid-model",
            "GROQ_API_KEY": "groq-test-key",
        }):
            providers = server.provider_settings()

        self.assertEqual(
            [(item["name"], item["model"]) for item in providers],
            [("Gemini", "gemini-3.8-flash"), ("OpenRouter", "openrouter/free")],
        )

    def test_photo_is_validated_and_added_as_gemini_inline_data(self):
        image = base64.b64encode(b"\xff\xd8\xff").decode("ascii")
        messages, _, _ = server.clean_chat_payload({
            "messages": [{
                "role": "user",
                "content": "What is in this photo?",
                "image": "data:image/jpeg;base64," + image,
            }],
        })
        request = server.make_provider_request({
            "name": "Gemini",
            "key": "test-key",
            "model": "gemini-3.8-flash",
            "kind": "gemini",
        }, messages, "Be helpful.", "casual")
        payload = json.loads(request.data.decode("utf-8"))

        self.assertEqual(payload["contents"][0]["parts"][1], {
            "inlineData": {"mimeType": "image/jpeg", "data": image},
        })

    def test_rejects_multiple_attached_photos(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff").decode("ascii")
        with self.assertRaisesRegex(server.ClientRequestError, "one photo at a time"):
            server.clean_chat_payload({
                "messages": [
                    {"role": "user", "content": "First photo", "image": image},
                    {"role": "user", "content": "Second photo", "image": image},
                ],
            })

    def test_photo_understanding_never_falls_back_to_nonvision_providers(self):
        gemini = {
            "name": "Gemini",
            "key": "gemini-key",
            "model": "gemini-3.8-flash",
            "kind": "gemini",
            "supports_images": True,
        }
        openrouter = provider("OpenRouter")
        image_message = {
            "role": "user",
            "content": "Describe this.",
            "image": {"mimeType": "image/jpeg", "data": "encoded"},
        }
        failure = server.ProviderFailure("Gemini", "rate limited", True, True)
        with patch.object(server, "provider_settings", return_value=[gemini, openrouter]), patch.object(
            server, "provider_reply", side_effect=failure
        ) as reply:
            with self.assertRaises(server.ImageUnderstandingUnavailable):
                server.complete_chat([image_message], "", "casual")
        reply.assert_called_once()

    def test_cloudflare_image_request_uses_flux_and_keeps_key_server_side(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        image = base64.b64encode(b"\xff\xd8\xffimage").decode("ascii")
        response.read.return_value = json.dumps({"result": {"image": image}}).encode("utf-8")
        with patch.dict(os.environ, {
            "CLOUDFLARE_ACCOUNT_ID": "account-test",
            "CLOUDFLARE_API_TOKEN": "private-token",
        }), patch("server.urllib.request.urlopen", return_value=response) as urlopen:
            result = server.generate_image("A bright landscape")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, (
            "https://api.cloudflare.com/client/v4/accounts/account-test/ai/run/"
            "@cf/black-forest-labs/flux-1-schnell"
        ))
        self.assertEqual(request.get_header("Authorization"), "Bearer private-token")
        self.assertEqual(result, "data:image/jpeg;base64," + image)

    def test_image_generation_is_disabled_without_cloudflare_credentials(self):
        with patch.dict(os.environ, {
            "CLOUDFLARE_ACCOUNT_ID": "",
            "CLOUDFLARE_API_TOKEN": "",
        }):
            with self.assertRaises(server.ImageGenerationUnavailable):
                server.generate_image("A bright landscape")


class AuthenticationTests(unittest.TestCase):
    def test_accepts_a_verified_supabase_email_session(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({
            "id": "verified-user-id",
            "email_confirmed_at": "2026-11-15T10:00:00Z",
        }).encode("utf-8")
        handler = Mock()
        handler.headers = {"Authorization": "Bearer verified-session-token"}
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_ANON_KEY": "public-test-anon-key",
        }), patch("server.urllib.request.urlopen", return_value=response) as urlopen:
            user_id = server.authenticated_user_id(handler)

        self.assertEqual(user_id, "verified-user-id")
        auth_request = urlopen.call_args.args[0]
        self.assertEqual(auth_request.get_header("Authorization"), "Bearer verified-session-token")
        self.assertEqual(auth_request.get_header("Apikey"), "public-test-anon-key")

    def test_rejects_an_unverified_supabase_email_session(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({
            "id": "unverified-user-id",
            "email_confirmed_at": None,
        }).encode("utf-8")
        handler = Mock()
        handler.headers = {"Authorization": "Bearer unverified-session-token"}
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_ANON_KEY": "public-test-anon-key",
        }), patch("server.urllib.request.urlopen", return_value=response):
            self.assertIsNone(server.authenticated_user_id(handler))


class BackendHttpTests(unittest.TestCase):
    def test_auth_config_exposes_only_public_supabase_settings(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        names = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")
        previous = {name: os.environ.pop(name, None) for name in names}
        os.environ["SUPABASE_URL"] = "https://example.supabase.co"
        os.environ["SUPABASE_ANON_KEY"] = "public-test-anon-key"
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "must-not-be-exposed"
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%s/api/auth-config" % httpd.server_address[1],
                timeout=5,
            ) as response:
                config = json.loads(response.read().decode("utf-8"))
            self.assertEqual(config, {
                "configured": True,
                "url": "https://example.supabase.co",
                "anonKey": "public-test-anon-key",
            })
        finally:
            for name in names:
                os.environ.pop(name, None)
                if previous[name] is not None:
                    os.environ[name] = previous[name]
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_all_provider_limits_return_the_requested_outage_message(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        providers = [provider("Gemini"), provider("Groq"), provider("OpenRouter")]
        failure = server.ProviderFailure("provider", "rate limited", True, True)
        body = json.dumps({
            "messages": [{"role": "user", "content": "Hello"}],
            "systemInstruction": "Be helpful.",
            "mode": "casual",
        }).encode("utf-8")
        request = urllib.request.Request(
            "http://127.0.0.1:%s/v1/chat" % httpd.server_address[1],
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Forwarded-For": "198.51.100.27",
            },
            method="POST",
        )
        try:
            with patch.object(server, "provider_settings", return_value=providers), patch.object(
                server, "provider_reply", side_effect=[failure, failure, failure]
            ), patch.object(server, "authenticated_user_id", return_value="user-1"):
                with self.assertRaises(urllib.error.HTTPError) as response:
                    urllib.request.urlopen(request, timeout=5)
            self.assertEqual(response.exception.code, 503)
            payload = json.loads(response.exception.read().decode("utf-8"))
            self.assertEqual(payload["error"], server.OUTAGE_MESSAGE)
            self.assertTrue(payload["allProvidersUnavailable"])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_serves_the_chat_website_and_its_assets(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base_url = "http://127.0.0.1:%s" % httpd.server_address[1]
        try:
            for path, content_type in (
                ("/", "text/html"),
                ("/styles.css", "text/css"),
                ("/app.js", "text/javascript"),
                ("/manifest.json", "application/manifest+json"),
                ("/icon.svg", "image/svg+xml"),
            ):
                with urllib.request.urlopen(base_url + path, timeout=5) as response:
                    body = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertIn(content_type, response.headers["Content-Type"])
                    self.assertTrue(body)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_website_status_endpoint_matches_the_frontend_contract(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(server, "available_providers", return_value={
                "configuredProviders": 1,
                "availableProviders": ["Gemini"],
                "available": True,
            }):
                with urllib.request.urlopen(
                    "http://127.0.0.1:%s/api/status" % httpd.server_address[1],
                    timeout=5,
                ) as response:
                    status = json.loads(response.read().decode("utf-8"))
            self.assertEqual(status, {
                "configured": True,
                "available": True,
                "availableProviders": ["Gemini"],
                "reason": "ready",
            })
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_website_chat_endpoint_uses_the_shared_backend_provider(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        body = json.dumps({
            "messages": [{"role": "user", "content": "Hello"}],
            "systemInstruction": "Be helpful.",
            "mode": "casual",
        }).encode("utf-8")
        request = urllib.request.Request(
            "http://127.0.0.1:%s/api/chat" % httpd.server_address[1],
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Forwarded-For": "198.51.100.28",
            },
            method="POST",
        )
        try:
            with patch.object(server, "provider_settings", return_value=[provider("Gemini")]), patch.object(
                server, "provider_reply", return_value="Website reply"
            ), patch.object(server, "authenticated_user_id", return_value="user-2"):
                with urllib.request.urlopen(request, timeout=5) as response:
                    result = json.loads(response.read().decode("utf-8"))
            self.assertEqual(result["text"], "Website reply")
            self.assertEqual(result["provider"], "Gemini")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_chat_endpoint_rejects_requests_without_a_verified_session(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        request = urllib.request.Request(
            "http://127.0.0.1:%s/api/chat" % httpd.server_address[1],
            data=b'{"messages":[{"role":"user","content":"Hello"}]}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with patch.object(server, "authenticated_user_id", return_value=None):
                with self.assertRaises(urllib.error.HTTPError) as response:
                    urllib.request.urlopen(request, timeout=5)
            self.assertEqual(response.exception.code, 401)
            payload = json.loads(response.exception.read().decode("utf-8"))
            self.assertEqual(payload["code"], "authentication_required")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_image_endpoint_uses_requested_failure_message_when_unavailable(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BackendHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        request = urllib.request.Request(
            "http://127.0.0.1:%s/api/images/generate" % httpd.server_address[1],
            data=json.dumps({"prompt": "A bright landscape"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with patch.object(server, "allow_request", return_value=True), patch.object(
                server, "authenticated_user_id", return_value="user-1"
            ), patch.object(server, "generate_image", side_effect=server.ImageGenerationUnavailable):
                with self.assertRaises(urllib.error.HTTPError) as response:
                    urllib.request.urlopen(request, timeout=5)
            self.assertEqual(response.exception.code, 503)
            payload = json.loads(response.exception.read().decode("utf-8"))
            self.assertEqual(payload["error"], "uhh looks like i cant generate photos right now")
            self.assertEqual(payload["code"], "image_generation_unavailable")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
