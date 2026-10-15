import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import launchables
from launchables import (
    APIConnectionError, APIError, AuthenticationError, InvalidRequestError,
    Launchables, LaunchablesError, OutOfCreditError, PermissionDeniedError,
    RateLimitError, ValidationError,
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


class KeyExpiryTests(Base):
    """0.2.0: the Launchables-Key-* headers, one warning at 14 days or fewer, and client.key()."""

    @staticmethod
    def in_days(n):
        import datetime
        return (datetime.datetime.now(datetime.timezone.utc).date() + datetime.timedelta(days=n)).isoformat()

    def test_header_is_read_and_the_callback_fires_once(self):
        seen = []
        c = Launchables(api_key="launchables_test", base_url=self.server.url, on_key_expiry=seen.append)
        for _ in range(2):
            self.reply(200, {"model": "m", "answers": {"q": NOUL}}, {"Launchables-Key-Id": "c_1", "Launchables-Key-Expires": self.in_days(10)})
            c.decide("s", {"q": noul("x")})
        self.assertEqual(c.key_expiry, launchables.KeyExpiry(key_id="c_1", expires_on=self.in_days(10), days_left=10))
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].days_left, 10)

    def test_no_callback_beyond_14_days_and_nothing_without_the_header(self):
        seen = []
        c = Launchables(api_key="launchables_test", base_url=self.server.url, on_key_expiry=seen.append)
        self.reply(200, {"model": "m", "answers": {"q": NOUL}}, {"Launchables-Key-Expires": self.in_days(40)})
        c.decide("s", {"q": noul("x")})
        self.assertEqual((c.key_expiry.days_left, seen), (40, []))
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        self.ask()
        self.assertIsNone(self.client.key_expiry)

    def test_without_a_callback_one_warning_is_issued(self):
        import warnings
        for _ in range(2):
            self.reply(200, {"model": "m", "answers": {"q": NOUL}}, {"Launchables-Key-Expires": self.in_days(3)})
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.ask(); self.ask()
        mine = [w for w in caught if issubclass(w.category, launchables.KeyExpiryWarning)]
        self.assertEqual(len(mine), 1)
        self.assertIn("3 days left", str(mine[0].message))

    def test_a_failing_callback_never_breaks_the_request_and_errors_carry_the_header(self):
        def boom(_):
            raise RuntimeError("boom")
        c = Launchables(api_key="launchables_test", base_url=self.server.url, on_key_expiry=boom)
        self.reply(402, {"error": "out of credit", "type": "out_of_credit"}, {"Launchables-Key-Expires": self.in_days(2)})
        with self.assertRaises(OutOfCreditError):
            c.decide("s", {"q": noul("x")})
        self.assertEqual(c.key_expiry.days_left, 2)

    def test_key_returns_the_calling_keys_details(self):
        info = {"id": "c_1", "name": "prod", "expires_on": self.in_days(30), "days_left": 30, "workspace": None,
                "rate_limit_per_minute": 60, "daily_limit": 2000, "paused": False}
        self.reply(200, info)
        k = self.client.key()
        self.assertEqual((k.id, k.name, k.days_left, k.paused, k.pause_reason), ("c_1", "prod", 30, False, None))
        r = self.server.requests[0]
        self.assertEqual((r["method"], r["path"], r["headers"]["Authorization"]), ("GET", "/v1/key", "Bearer launchables_test"))

    def test_a_new_key_on_the_same_client_warns_again(self):
        seen = []
        c = Launchables(api_key="launchables_test", base_url=self.server.url, on_key_expiry=lambda e: seen.append(e.key_id))
        for kid, days in (("c_1", 5), ("c_2", 9), ("c_2", 9)):
            self.reply(200, {"model": "m", "answers": {"q": NOUL}}, {"Launchables-Key-Id": kid, "Launchables-Key-Expires": self.in_days(days)})
            c.decide("s", {"q": noul("x")})
        self.assertEqual(seen, ["c_1", "c_2"])

    def test_key_needs_an_api_key(self):
        with self.assertRaises(AuthenticationError):
            Launchables(base_url=self.server.url).key()


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
        self.assertIsNone(e.type)
        self.assertEqual(len(self.server.requests), 4 if retried else 1)

    def check_typed(self, status, cls, type_):
        for _ in range(5):
            self.reply(status, {"error": f"no: {type_}", "type": type_})
        with self.assertRaises(cls) as cm:
            self.ask()
        e = cm.exception
        self.assertIsInstance(e, LaunchablesError)
        self.assertEqual(e.status, status)
        self.assertEqual(e.type, type_)
        self.assertEqual(e.message, f"no: {type_}")
        self.assertEqual(e.body, {"error": f"no: {type_}", "type": type_})
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.sleeps, [])

    def test_401(self): self.check(401, AuthenticationError)
    def test_402(self): self.check(402, OutOfCreditError)
    def test_403(self): self.check(403, PermissionDeniedError)
    def test_402_out_of_credit(self): self.check_typed(402, OutOfCreditError, "out_of_credit")
    def test_402_budget_exceeded(self): self.check_typed(402, OutOfCreditError, "budget_exceeded")
    def test_403_model_not_allowed(self): self.check_typed(403, PermissionDeniedError, "model_not_allowed")
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
        self.assertIsNone(cm.exception.type)

    def test_type_on_other_errors(self):
        self.reply(401, {"error": "bad key", "type": "invalid_api_key"})
        with self.assertRaises(AuthenticationError) as cm:
            self.ask()
        self.assertEqual(cm.exception.type, "invalid_api_key")
        c = Launchables(api_key="k", base_url=self.server.url, max_retries=0)
        self.reply(429, {"error": "slow", "type": "rate_limited"})
        with self.assertRaises(RateLimitError) as cm:
            c.decide("s", {"q": noul("x")})
        self.assertEqual(cm.exception.type, "rate_limited")
        self.reply(400, {"error": "bad", "type": 7})
        with self.assertRaises(InvalidRequestError) as cm:
            self.ask()
        self.assertIsNone(cm.exception.type)
        self.assertIsNone(LaunchablesError("local").type)


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
