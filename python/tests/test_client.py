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
    RateLimitError, ValidationError, NotFoundError, ConflictError, DEFAULT_ADMIN_BASE_URL,
    IdempotencyKeyAlreadyUsedError, BatchResultsDeletedError,
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
                step = outer.script.pop(0) if outer.script else (200, {}, {})
                if step == "drop":  # hang up without answering
                    self.close_connection = True
                    return
                status, payload, headers = step
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_DELETE = _serve

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
        for kid, days in (("c_1", 5), ("c_2", 9), ("c_2", 9), ("c_1", 5)):
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


class IdempotencyTests(Base):
    ANSWER = {"model": "m", "answers": {"q": NOUL}}

    def keys(self):
        return [r["headers"].get("Idempotency-Key") for r in self.server.requests]

    def test_every_call_gets_a_new_random_key_and_every_retry_the_same_one(self):
        self.reply(503, {"error": "busy"})
        self.reply(502, {"error": "x"})
        self.reply(200, self.ANSWER)
        self.reply(200, self.ANSWER)
        self.ask()
        self.ask()
        keys = self.keys()
        self.assertEqual(len(keys), 4)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(keys[1], keys[2])  # one logical request, retried twice: one key
        self.assertNotEqual(keys[2], keys[3])  # the next call: a new key
        import uuid
        for key in keys:
            self.assertEqual(str(uuid.UUID(key)), key)
            self.assertEqual(uuid.UUID(key).version, 4)

    def test_the_same_key_after_a_lost_connection(self):
        self.server.script.append("drop")
        self.reply(200, self.ANSWER)
        self.ask()
        keys = self.keys()
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])

    def test_a_callers_own_key_is_sent(self):
        self.reply(200, self.ANSWER)
        self.client.decide("s", {"q": noul("x")}, model="m", idempotency_key="order-4471-refund")
        self.assertEqual(self.keys(), ["order-4471-refund"])

    def test_a_bad_key_is_refused_before_sending(self):
        for bad in ("", "x" * 256, "caf\u00e9", "tab\there", 42):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                self.client.decide("s", {"q": noul("x")}, idempotency_key=bad)
        self.assertEqual(self.server.requests, [])
        self.reply(200, self.ANSWER)
        self.client.decide("s", {"q": noul("x")}, idempotency_key="x" * 255)

    def test_in_progress_is_waited_out_without_using_up_retries(self):
        c = Launchables(api_key="k", base_url=self.server.url, max_retries=1)
        busy = {"error": "still being answered", "type": "idempotency_in_progress", "retry_after": 2}
        for _ in range(5):
            self.reply(409, busy, {"Retry-After": "2"})
        self.reply(503, {"error": "y"})
        self.reply(200, self.ANSWER)  # the first attempt failed, so this repeat is answered as a new request
        self.assertEqual(c.decide("s", {"q": noul("x")}).answers["q"].noul, 0.04)
        self.assertEqual(self.sleeps, [2.0] * 5 + [0.5])
        self.assertEqual(len(set(self.keys())), 1)

    def test_in_progress_gives_up_after_the_wait_limit(self):
        busy = {"error": "still being answered", "type": "idempotency_in_progress"}
        for _ in range(100):
            self.reply(409, busy, {"Retry-After": "60"})
        with self.assertRaises(ConflictError) as cm:
            self.ask()
        self.assertEqual(cm.exception.type, "idempotency_in_progress")
        self.assertEqual(sum(self.sleeps), 120.0)  # 60 + 60; a third would pass 150 s
        self.assertEqual(len(self.server.requests), 3)

    def test_in_progress_with_retry_after_zero_still_ends(self):
        busy = {"error": "still being answered", "type": "idempotency_in_progress"}
        for _ in range(700):
            self.reply(409, busy, {"Retry-After": "0"})
        with self.assertRaises(ConflictError):
            self.ask()
        self.assertTrue(all(s == 0.25 for s in self.sleeps))  # at least 250 ms a wait
        self.assertEqual(len(self.sleeps), 600)  # 600 x 0.25 s = 150 s
        self.assertEqual(len(self.server.requests), 601)

    def test_a_reused_key_is_raised_and_not_retried(self):
        self.reply(422, {"error": "used for a different request", "type": "idempotency_key_reused"})
        with self.assertRaises(InvalidRequestError) as cm:
            self.client.decide("s", {"q": noul("x")}, idempotency_key="k1")
        self.assertEqual(cm.exception.type, "idempotency_key_reused")
        self.assertEqual(len(self.server.requests), 1)

    USED = {"error": "this Idempotency-Key was already used for this request, which was answered; the answer is not "
                     "kept, so read it from your own records, or send a new key to have the request answered (and "
                     "billed) again", "type": "idempotency_key_already_used", "detail": ["header", "Idempotency-Key"],
            "request_id": "req_0123456789abcdef"}

    def test_already_used_after_a_lost_answer_is_raised_and_not_retried(self):
        self.server.script.append("drop")  # the first attempt was answered, but the answer never arrived
        self.reply(409, self.USED)
        self.reply(200, self.ANSWER)  # never reached
        with self.assertRaises(IdempotencyKeyAlreadyUsedError) as cm:
            self.client.decide("s", {"q": noul("x")}, idempotency_key="order-4471")
        e = cm.exception
        self.assertIsInstance(e, ConflictError)  # existing ConflictError handlers still catch it
        self.assertEqual(e.status, 409)
        self.assertEqual(e.type, "idempotency_key_already_used")
        self.assertEqual(e.request_id, "req_0123456789abcdef")
        self.assertIsNone(e.batch_id)
        self.assertIn("req_0123456789abcdef", e.message)
        self.assertIn("new idempotency_key", e.message)
        self.assertIn("billed again", e.message)
        self.assertEqual(e.server_message, self.USED["error"])
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.keys(), ["order-4471", "order-4471"])
        self.assertEqual(self.sleeps, [0.5])  # only the wait after the lost connection

    def test_already_used_after_waiting_out_in_progress_is_raised(self):
        self.reply(409, {"error": "still being answered", "type": "idempotency_in_progress"}, {"Retry-After": "2"})
        self.reply(409, self.USED)
        with self.assertRaises(IdempotencyKeyAlreadyUsedError) as cm:
            self.ask()
        self.assertEqual(cm.exception.request_id, "req_0123456789abcdef")
        self.assertEqual(self.sleeps, [2.0])
        self.assertEqual(len(self.server.requests), 2)

    def test_already_used_without_a_request_id_still_explains(self):
        self.reply(409, {"error": "used", "type": "idempotency_key_already_used", "request_id": None})
        with self.assertRaises(IdempotencyKeyAlreadyUsedError) as cm:
            self.ask()
        self.assertIsNone(cm.exception.request_id)
        self.assertIn("new idempotency_key", str(cm.exception))

    def test_other_conflicts_and_gone_stay_as_they_were(self):
        self.reply(409, {"error": "key limit", "type": "key_limit"})
        with self.assertRaises(ConflictError) as cm:
            self.ask()
        self.assertNotIsInstance(cm.exception, IdempotencyKeyAlreadyUsedError)
        self.reply(410, {"error": "gone"})
        with self.assertRaises(InvalidRequestError) as cm:
            self.ask()
        self.assertNotIsInstance(cm.exception, BatchResultsDeletedError)

    def test_other_requests_carry_no_key(self):
        self.reply(200, {"data": []})
        self.reply(200, {"status": "ok"})
        self.client.models()
        self.client.health()
        self.assertEqual(self.keys(), [None, None])


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
        choice("x", [str(i) for i in range(256)])
        with self.assertRaisesRegex(ValidationError, "at most 256"):
            choice("x", [str(i) for i in range(257)])
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
        qs = {f"q{i}": noul("x") for i in range(257)}
        with self.assertRaisesRegex(ValidationError, "at most 256"):
            self.client.decide("s", qs)
        wide = {f"q{i}": choice("x", [str(j) for j in range(250)]) for i in range(17)}
        with self.assertRaisesRegex(ValidationError, "at most 4096 options"):
            self.client.decide("s", wide)
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


ADMIN = "launchables_admin_test"
KEY = {"id": "c_1a2b3c4d", "name": "ci", "prefix": "launchables_AbCd1234", "workspace": {"id": "w1", "name": "Default"},
       "created_at": "2026-10-15T12:00:00Z", "expires_on": "2027-01-13", "last_used_on": None, "status": "active", "revoked_at": None}


class AdminKeysTests(Base):
    def setUp(self):
        super().setUp()
        os.environ.pop("LAUNCHABLES_ADMIN_KEY", None)
        self.admin = Launchables(api_key="launchables_test", base_url="http://127.0.0.1:9", admin_key=ADMIN, admin_base_url=self.server.url)

    def test_list_sends_the_admin_key_to_the_console(self):
        self.reply(200, {"data": [KEY], "has_more": False, "next_before": None})
        page = self.admin.admin.keys.list()
        self.assertEqual(page["data"], [KEY])
        req = self.server.requests[0]
        self.assertEqual((req["method"], req["path"]), ("GET", "/api/v1/admin/keys"))
        self.assertEqual(req["headers"]["Authorization"], f"Bearer {ADMIN}")

    def test_the_console_is_the_default(self):
        self.assertEqual(Launchables().admin_base_url, "https://console.launchables.ai")
        self.assertEqual(DEFAULT_ADMIN_BASE_URL, "https://console.launchables.ai")

    def test_list_all_follows_pages(self):
        self.reply(200, {"data": [KEY], "has_more": True, "next_before": "abc+/="})
        self.reply(200, {"data": [dict(KEY, id="c_00000002")], "has_more": False, "next_before": None})
        ids = [k["id"] for k in self.admin.admin.keys.list_all(limit=1)]
        self.assertEqual(ids, ["c_1a2b3c4d", "c_00000002"])
        self.assertEqual(self.server.requests[0]["path"], "/api/v1/admin/keys?limit=1")
        self.assertEqual(self.server.requests[1]["path"], "/api/v1/admin/keys?limit=1&before=abc%2B%2F%3D")

    def test_create_roll_revoke(self):
        made = {"id": "c_1a2b3c4d", "name": "ci", "key": "launchables_secret", "expires_on": "2026-11-14"}
        self.reply(201, made)
        self.reply(201, dict(made, id="c_99999999", replaces={"id": "c_1a2b3c4d", "expires_on": "2026-10-16"}))
        self.reply(200, {"id": "c_99999999", "status": "revoked", "revoked_at": "2026-10-15T12:00:00Z"})
        self.assertEqual(self.admin.admin.keys.create("ci", expires_in_days=30), made)
        self.assertEqual(self.server.requests[0]["body"], {"name": "ci", "expires_in_days": 30})
        r = self.admin.admin.keys.roll("c_1a2b3c4d")
        self.assertEqual(r["replaces"]["expires_on"], "2026-10-16")
        self.assertEqual(self.server.requests[1]["path"], "/api/v1/admin/keys/c_1a2b3c4d/roll")
        self.assertEqual(self.admin.admin.keys.revoke("c_99999999")["status"], "revoked")
        self.assertEqual((self.server.requests[2]["method"], self.server.requests[2]["path"]), ("DELETE", "/api/v1/admin/keys/c_99999999"))

    def test_ids_are_escaped(self):
        self.reply(404, {"error": {"type": "not_found_error", "message": "No key"}})
        with self.assertRaises(NotFoundError):
            self.admin.admin.keys.revoke("../x")
        self.assertEqual(self.server.requests[0]["path"], "/api/v1/admin/keys/..%2Fx")

    def test_errors_carry_type_and_message(self):
        self.reply(409, {"error": {"type": "conflict_error", "message": "This organisation has 5 active keys"}})
        with self.assertRaises(ConflictError) as cm:
            self.admin.admin.keys.create("x")
        e = cm.exception
        self.assertIsInstance(e, InvalidRequestError)
        self.assertEqual((e.type, e.message, e.status), ("conflict_error", "This organisation has 5 active keys", 409))

    def test_no_admin_key(self):
        with self.assertRaises(AuthenticationError):
            self.client.admin.keys.list()
        self.assertEqual(self.server.requests, [])

    def test_env_admin_key(self):
        os.environ["LAUNCHABLES_ADMIN_KEY"] = "launchables_admin_env"
        self.reply(200, {"data": [], "has_more": False, "next_before": None})
        Launchables(admin_base_url=self.server.url).admin.keys.list()
        self.assertEqual(self.server.requests[0]["headers"]["Authorization"], "Bearer launchables_admin_env")

    def test_local_validation(self):
        with self.assertRaises(ValidationError):
            self.admin.admin.keys.create(" ")
        with self.assertRaises(ValidationError):
            self.admin.admin.keys.roll("")
        self.assertEqual(self.server.requests, [])

    def test_create_and_roll_not_retried_after_503(self):
        self.reply(503, {"error": {"type": "api_error", "message": "try again"}})
        self.reply(503, {"error": {"type": "api_error", "message": "try again"}})
        with self.assertRaises(APIError):
            self.admin.admin.keys.create("x")
        with self.assertRaises(APIError):
            self.admin.admin.keys.roll("c_1a2b3c4d")
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.sleeps, [])

    def test_create_not_retried_after_lost_connection(self):
        client = Launchables(admin_key=ADMIN, admin_base_url="http://127.0.0.1:9")
        with self.assertRaises(APIConnectionError):
            client.admin.keys.create("x")
        self.assertEqual(self.sleeps, [])

    def test_429_retried_and_list_retries_like_any_call(self):
        self.reply(429, {"error": {"type": "rate_limit_error", "message": "slow down"}})
        self.reply(201, {"id": "c_1"})
        self.reply(503, b"x")
        self.reply(200, {"data": [], "has_more": False, "next_before": None})
        self.assertEqual(self.admin.admin.keys.create("x")["id"], "c_1")
        self.admin.admin.keys.list()
        self.assertEqual(len(self.server.requests), 4)
        self.assertEqual(self.sleeps, [0.5, 0.5])

    def test_an_empty_admin_url_never_falls_back_to_the_decision_api(self):
        client = Launchables(base_url=self.server.url, admin_key=ADMIN, admin_base_url="")
        with self.assertRaises(Exception):
            client.admin.keys.list()
        self.assertEqual(self.server.requests, [])

    def test_console_responses_never_set_the_api_keys_expiry(self):
        self.reply(200, {"data": [], "has_more": False, "next_before": None}, {"Launchables-Key-Expires": "2026-10-16"})
        self.admin.admin.keys.list()
        self.assertIsNone(self.admin.key_expiry)


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


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00" * 20
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 20


class ImageTests(Base):
    """0.4.0: assets, image_budget and the Image helper."""

    def test_assets_and_budget_are_sent(self):
        import base64
        self.reply(200, {"model": "m", "answers": {"q": NOUL}, "usage": {"input_tokens": 300, "output_tokens": 1}})
        r = self.client.decide(
            {"receipt": "receipt_photo"}, {"q": noul("Does the total on receipt_photo equal 23.40?")},
            assets={"receipt_photo": launchables.Image.from_bytes(JPEG)}, image_budget=140,
        )
        self.assertEqual(r.usage.input_tokens, 300)
        body = self.server.requests[0]["body"]
        self.assertEqual(body["assets"], {"receipt_photo": {
            "type": "image", "format": "jpeg", "data_base64": base64.b64encode(JPEG).decode()}})
        self.assertEqual(body["image_budget"], 140)
        self.assertEqual(set(body), {"state", "questions", "assets", "image_budget"})

    def test_no_assets_or_budget_means_neither_is_sent(self):
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        self.ask()
        self.assertEqual(set(self.server.requests[0]["body"]), {"state", "questions"})

    def test_a_plain_dict_is_sent_as_is(self):
        self.reply(200, {"model": "m", "answers": {"q": NOUL}})
        asset = {"format": "png", "data_base64": "AAAA"}
        self.client.decide("see img", {"q": noul("img ok?")}, assets={"img": asset})
        body = self.server.requests[0]["body"]
        self.assertEqual(body["assets"], {"img": asset})
        self.assertNotIn("image_budget", body)

    def test_budget_must_be_70_140_or_280(self):
        for bad in (0, 100, 281, "280", 280.0, True, -1):
            with self.assertRaises(ValidationError) as cm:
                self.client.decide("img", {"q": noul("x")}, assets={"img": launchables.Image.from_bytes(PNG)}, image_budget=bad)
            self.assertIn("70, 140, 280", str(cm.exception))
        for good in (70, 140, 280):
            self.reply(200, {"model": "m", "answers": {"q": NOUL}})
            self.client.decide("s", {"q": noul("x")}, image_budget=good)
            self.assertEqual(self.server.requests[-1]["body"]["image_budget"], good)

    def test_bad_assets_are_refused_before_sending(self):
        for bad in ([("img", PNG)], {"": launchables.Image.from_bytes(PNG)}, {"img": PNG}, {"img": "AAAA"}):
            with self.assertRaises(ValidationError):
                self.client.decide("img", {"q": noul("x")}, assets=bad)
        self.assertEqual(self.server.requests, [])

    def test_format_is_detected_from_the_bytes(self):
        self.assertEqual(launchables.Image.from_bytes(PNG).format, "png")
        self.assertEqual(launchables.Image.from_bytes(bytearray(JPEG)).format, "jpeg")
        self.assertEqual(launchables.Image.from_bytes(JPEG, format="JPG").to_dict()["format"], "jpg")
        self.assertEqual(launchables.Image.from_bytes(PNG, format="png").to_dict()["type"], "image")

    def test_unknown_or_mismatched_formats_are_refused(self):
        for data, fmt in ((b"GIF89a" + b"\x00" * 10, None), (b"RIFF\x00\x00\x00\x00WEBP", None), (b"", None),
                          (PNG, "gif"), (PNG, "jpeg"), (JPEG, "png"), (b"GIF89a", "png")):
            with self.assertRaises(ValidationError):
                launchables.Image.from_bytes(data, format=fmt)
        with self.assertRaises(ValidationError):
            launchables.Image.from_bytes("not bytes")

    def test_over_16_mib_is_refused(self):
        launchables.Image.from_bytes(PNG + b"\x00" * (launchables.MAX_IMAGE_BYTES - len(PNG)))
        with self.assertRaises(ValidationError) as cm:
            launchables.Image.from_bytes(PNG + b"\x00" * (launchables.MAX_IMAGE_BYTES - len(PNG) + 1))
        self.assertIn("16 MiB", str(cm.exception))

    def test_from_path(self):
        import base64
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "photo.bin")  # the name does not decide the format
            with open(p, "wb") as f:
                f.write(PNG)
            img = launchables.Image.from_path(p)
            self.assertEqual(img.to_dict(), {"type": "image", "format": "png", "data_base64": base64.b64encode(PNG).decode()})
            with self.assertRaises(ValidationError):
                launchables.Image.from_path(p, format="jpeg")

    @unittest.skipUnless(os.path.exists("/dev/zero"), "needs /dev/zero")
    def test_from_path_reads_no_more_than_the_limit(self):
        # a device reports no size and never ends; the read stops one byte past 16 MiB and the image is refused
        with self.assertRaises(ValidationError) as cm:
            launchables.Image.from_path("/dev/zero")
        self.assertIn("16 MiB", str(cm.exception))

    def test_image_error_types_are_exposed(self):
        for status, type_ in ((400, "unsupported_image_format"), (400, "image_dimensions"),
                              (400, "unreferenced_asset"), (422, "invalid_image_budget")):
            self.reply(status, {"error": f"asset 'img': {type_}", "type": type_})
            with self.assertRaises(InvalidRequestError) as cm:
                self.client.decide("img", {"q": noul("x")}, assets={"img": launchables.Image.from_bytes(PNG)})
            self.assertEqual((cm.exception.status, cm.exception.type), (status, type_))
            self.assertIn("asset 'img'", cm.exception.message)
