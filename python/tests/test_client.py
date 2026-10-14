import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import launchables
from launchables import (
    APIConnectionError, APIError, AuthenticationError, InvalidRequestError,
    Launchables, LaunchablesError, RateLimitError, ValidationError,
    choice, noul, score,
)
from launchables import client as client_module

NOUL = {"type": "noul", "noul": 0.04}
CHOICE = {"type": "choice", "choice": "returns",
          "probabilities": {"billing": 0.06, "returns": 0.89, "other": 0.05}}
SCORE = {"type": "score", "score": 1.92, "level": 2,
         "probabilities": {"0": 0.03, "1": 0.12, "2": 0.75, "3": 0.10}}


class Server:
    """Local HTTP server replaying a scripted list of (status, body, headers)."""

    def __init__(self):
        self.script = []
        self.requests = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _serve(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                outer.requests.append({
                    "method": self.command, "path": self.path,
                    "headers": dict(self.headers.items()),
                    "body": json.loads(body) if body else None,
                })
                status, payload, headers = outer.script.pop(0) if outer.script else (200, {}, {})
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _serve

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Base(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.addCleanup(self.server.close)
        self.sleeps = []
        p = mock.patch.object(client_module, "_sleep", self.sleeps.append)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.dict(os.environ, {}, clear=False)
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("LAUNCHABLES_API_TOKEN", None)
        self.client = Launchables(api_key="launchables_test", base_url=self.server.url)

    def reply(self, status, payload=None, headers=None):
        self.server.script.append((status, payload if payload is not None else {}, headers))

    def ask(self):
        return self.client.decide("state", {"q": noul("Is it?")})


class DecideTests(Base):
    def test_noul(self):
        self.reply(200, {"model": "myles-g-12b", "answers": {"refund": NOUL},
                         "usage": {"input_tokens": 10, "output_tokens": 2}})
        r = self.client.decide("Bought 12 days ago", {"refund": noul("Refund permitted?")})
        a = r.answers["refund"]
        self.assertEqual(a.probability, 0.04)
        self.assertEqual(a.noul, 0.04)
        self.assertEqual(r.model, "myles-g-12b")
        self.assertEqual((r.usage.input_tokens, r.usage.output_tokens), (10, 2))
        self.assertEqual(r.raw["answers"]["refund"], NOUL)
        req = self.server.requests[0]
        self.assertEqual(req["method"], "POST")
        self.assertEqual(req["path"], "/v1/decide")
        self.assertEqual(req["headers"]["Authorization"], "Bearer launchables_test")
        self.assertEqual(req["headers"]["User-Agent"], f"launchables-python/{launchables.__version__}")
        self.assertEqual(req["body"], {"state": "Bought 12 days ago",
                                       "questions": {"refund": {"type": "noul", "instructions": "Refund permitted?"}}})

    def test_choice(self):
        self.reply(200, {"model": "m", "answers": {"topic": CHOICE}, "usage": {}})
        r = self.client.decide({"ticket": "x"}, {"topic": choice("Topic?", ["billing", "returns", "other"])}, model="m")
        a = r.answers["topic"]
        self.assertEqual(a.choice, "returns")
        self.assertEqual(a.probabilities["returns"], 0.89)
        body = self.server.requests[0]["body"]
        self.assertEqual(body["state"], {"ticket": "x"})
        self.assertEqual(body["model"], "m")

    def test_score(self):
        self.reply(200, {"model": "m", "answers": {"urg": SCORE}, "usage": {}})
        r = self.client.decide("s", {"urg": score("Urgency?", ["none", "low", "mid", "high"])})
        a = r.answers["urg"]
        self.assertEqual((a.level, a.score), (2, 1.92))
        self.assertEqual(a.probabilities["2"], 0.75)

    def test_models_and_health_need_no_auth(self):
        self.reply(200, {"object": "list", "data": [{"id": "myles-g-12b", "object": "model", "owned_by": "launchables"}]})
        self.reply(200, {"status": "ok"})
        c = Launchables(base_url=self.server.url + "/")
        self.assertEqual(c.models()[0].id, "myles-g-12b")
        self.assertEqual(c.health(), {"status": "ok"})
        for req in self.server.requests:
            self.assertNotIn("Authorization", req["headers"])
        self.assertEqual([r["path"] for r in self.server.requests], ["/v1/models", "/health"])


class KeyTests(Base):
    def test_missing_key(self):
        c = Launchables(base_url=self.server.url)
        with self.assertRaises(AuthenticationError) as cm:
            c.decide("s", {"q": noul("x")})
        self.assertIn("LAUNCHABLES_API_TOKEN", str(cm.exception))
        self.assertEqual(self.server.requests, [])

    def test_env_var(self):
        os.environ["LAUNCHABLES_API_TOKEN"] = "launchables_env"
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        Launchables(base_url=self.server.url).decide("s", {"q": noul("x")})
        self.assertEqual(self.server.requests[0]["headers"]["Authorization"], "Bearer launchables_env")

    def test_explicit_key_beats_env(self):
        os.environ["LAUNCHABLES_API_TOKEN"] = "launchables_env"
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        self.ask()
        self.assertEqual(self.server.requests[0]["headers"]["Authorization"], "Bearer launchables_test")


class ErrorTests(Base):
    def check(self, status, cls, retried=False):
        for _ in range(5):
            self.reply(status, {"error": f"boom {status}"})
        with self.assertRaises(cls) as cm:
            self.ask()
        e = cm.exception
        self.assertEqual(e.status, status)
        self.assertIn(f"boom {status}", e.message)
        self.assertIsInstance(e, LaunchablesError)
        self.assertEqual(len(self.server.requests), 4 if retried else 1)

    def test_401(self): self.check(401, AuthenticationError)
    def test_400(self): self.check(400, InvalidRequestError)
    def test_404(self): self.check(404, InvalidRequestError)
    def test_411(self): self.check(411, InvalidRequestError)
    def test_413(self): self.check(413, InvalidRequestError)
    def test_422(self): self.check(422, InvalidRequestError)
    def test_429(self): self.check(429, RateLimitError, retried=True)
    def test_502(self): self.check(502, APIError, retried=True)
    def test_503(self): self.check(503, APIError, retried=True)
    def test_500_not_retried(self): self.check(500, APIError)

    def test_non_json_error_body(self):
        self.reply(422, b"plain text failure")
        with self.assertRaises(InvalidRequestError) as cm:
            self.ask()
        self.assertEqual(cm.exception.message, "plain text failure")


class RetryTests(Base):
    def test_backoff_then_success(self):
        self.reply(429, {"error": "slow"})
        self.reply(502, {"error": "x"})
        self.reply(503, {"error": "y"})
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        self.assertEqual(self.ask().answers["q"].noul, 0.04)
        self.assertEqual(self.sleeps, [0.5, 1.0, 2.0])
        self.assertEqual(len(self.server.requests), 4)

    def test_retry_after_honoured(self):
        self.reply(429, {"error": "slow"}, {"Retry-After": "7"})
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        self.ask()
        self.assertEqual(self.sleeps, [7.0])

    def test_rate_limit_error_carries_retry_after(self):
        c = Launchables(api_key="k", base_url=self.server.url, max_retries=0)
        self.reply(429, {"error": "daily limit"}, {"Retry-After": "30"})
        with self.assertRaises(RateLimitError) as cm:
            c.decide("s", {"q": noul("x")})
        self.assertEqual(cm.exception.retry_after, 30.0)
        self.assertEqual(self.sleeps, [])

    def test_max_retries_zero(self):
        c = Launchables(api_key="k", base_url=self.server.url, max_retries=0)
        self.reply(503, {"error": "maintenance"})
        with self.assertRaises(APIError):
            c.decide("s", {"q": noul("x")})
        self.assertEqual(len(self.server.requests), 1)

    def test_connection_error_retried_then_raised(self):
        url = self.server.url
        self.server.close()
        c = Launchables(api_key="k", base_url=url, max_retries=2)
        with self.assertRaises(APIConnectionError):
            c.decide("s", {"q": noul("x")})
        self.assertEqual(self.sleeps, [0.5, 1.0])

    def test_400_never_retried(self):
        self.reply(400, {"error": "bad"})
        with self.assertRaises(InvalidRequestError):
            self.ask()
        self.assertEqual(self.sleeps, [])


class ValidationTests(Base):
    def test_noul_criteria(self):
        q = noul("x", true="yes means a", false="no means b")
        self.assertEqual(q["criteria"], {"true": "yes means a", "false": "no means b"})
        self.assertNotIn("criteria", noul("x"))

    def test_choice_dict_and_list(self):
        self.assertEqual(choice("x", {"a": "A", "b": "B"})["criteria"], {"a": "A", "b": "B"})
        self.assertEqual(choice("x", ("a", "b"))["criteria"], ["a", "b"])

    def test_choice_limits(self):
        choice("x", [str(i) for i in range(26)])
        with self.assertRaisesRegex(ValidationError, "at most 26"):
            choice("x", [str(i) for i in range(27)])
        with self.assertRaises(ValidationError):
            choice("x", [])
        with self.assertRaises(ValidationError):
            choice("x", "abc")
        with self.assertRaisesRegex(ValidationError, "unique"):
            choice("x", ["a", "a"])

    def test_score(self):
        with self.assertRaises(ValidationError):
            score("x", ["only one"])
        with self.assertRaises(ValidationError):
            score("x", "abc")

    def test_instructions(self):
        with self.assertRaises(ValidationError):
            noul("  ")

    def test_too_many_questions(self):
        qs = {f"q{i}": noul("x") for i in range(17)}
        with self.assertRaisesRegex(ValidationError, "at most 16"):
            self.client.decide("s", qs)
        self.client.decide  # 16 is fine (validated, not sent here)
        self.assertEqual(self.server.requests, [])

    def test_sixteen_ok(self):
        self.reply(200, {"model": "m", "answers": {}})
        self.client.decide("s", {f"q{i}": noul("x") for i in range(16)})

    def test_bad_raw_questions(self):
        for bad in ({}, [], {"q": "text"}, {"q": {"type": "bogus", "instructions": "x"}},
                    {"q": {"type": "choice", "instructions": "x"}},
                    {"q": {"type": "score", "instructions": "x"}},
                    {"q": {"type": "noul"}}):
            with self.assertRaises(ValidationError, msg=str(bad)):
                self.client.decide("s", bad)

    def test_bad_state(self):
        with self.assertRaises(ValidationError):
            self.client.decide(123, {"q": noul("x")})
        self.assertEqual(self.server.requests, [])

    def test_validation_error_is_invalid_request(self):
        self.assertTrue(issubclass(ValidationError, InvalidRequestError))
        self.assertTrue(issubclass(ValidationError, ValueError))


class NoulDecideTests(unittest.TestCase):
    def test_thresholds(self):
        from launchables import NoulAnswer
        self.assertEqual(NoulAnswer(0.95).decide(), "yes")
        self.assertEqual(NoulAnswer(0.04).decide(), "no")
        self.assertEqual(NoulAnswer(0.5).decide(), "person")
        self.assertEqual(NoulAnswer(0.9).decide(), "yes")
        self.assertEqual(NoulAnswer(0.6).decide(threshold_yes=0.6, threshold_no=0.4), "yes")
        with self.assertRaises(ValueError):
            NoulAnswer(0.5).decide(threshold_yes=0.2, threshold_no=0.8)


if __name__ == "__main__":
    unittest.main()
