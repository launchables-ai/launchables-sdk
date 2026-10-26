import datetime
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from launchables import (
    APIConnectionError, APIError, AnsweredBatchResult, Batch, BatchTimeoutError, BatchWaitCancelledError, ConflictError,
    CreatedBatch, FailedBatchResult, Image, InvalidRequestError, Launchables, LaunchablesError, NoulAnswer, NotFoundError,
    RateLimitError, ValidationError, choice, noul, to_jsonl,
)
from launchables import client as client_module
from launchables.batches import finished, parse_batch

ID = "batch_0123456789abcdef01234567"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def line(custom_id, **extra):
    out = {"custom_id": custom_id, "model": "myles-g-12b", "state": "Charged twice for order 4471",
           "questions": {"refund": noul("Is a refund due?")}}
    out.update(extra)
    return out


ESTIMATE = {"amount": 0.0000012, "currency": "GBP", "input_tokens": 1600, "rate": 0.5, "basis": "estimate"}
CREATED = {"id": ID, "object": "batch", "status": "queued", "lines": 2, "expires_at": "2026-10-20T12:00:00+00:00",
           "data_region": "CANADA-1 (Canada)", "estimated_cost": ESTIMATE}


def status(s, counts, lines=2, finished_at=None):
    return {"id": ID, "object": "batch", "status": s, "lines": lines, "counts": counts, "models": ["myles-g-12b"],
            "created_at": "2026-10-19T12:00:00+00:00", "started_at": None, "finished_at": finished_at,
            "expires_at": "2026-10-20T12:00:00+00:00", "reason": None,
            "results_available": s in ("done", "failed", "cancelled"), "webhook": False, "estimated_cost": ESTIMATE,
            "data_region": "CANADA-1 (Canada)", "delete_after": None}


def counts(done, failed, pending):
    return {"done": done, "failed": failed, "pending": pending}


ANSWERED = {"custom_id": "a", "model": "myles-g-12b-20261017", "status": 200,
            "response": {"model": "myles-g-12b-20261017", "answers": {"refund": {"type": "noul", "noul": 0.97}},
                         "usage": {"input_tokens": 120, "output_tokens": 1}},
            "usage": {"input_tokens": 120, "output_tokens": 1, "batch": True}}
EXPIRED = {"custom_id": "b", "model": "myles-g-12b", "status": None,
           "error": {"type": "expired", "error": "this line was not run (expired)"},
           "usage": {"input_tokens": 0, "output_tokens": 0, "batch": True}}


def jsonl(*rows):
    return ("".join(json.dumps(r) + "\n" for r in rows)).encode()


class Server:
    """Local HTTP server replaying a script of (status, body, headers); a body of bytes is sent as it is, a callable
    instead of a tuple drops the connection."""

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
                outer.requests.append({"method": self.command, "path": self.path,
                                       "headers": dict(self.headers.items()), "body": body})
                step = outer.script.pop(0) if outer.script else (200, {}, {})
                if step == "drop":
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                status_code, payload, headers = step
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status_code)
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
        self.client = Launchables(api_key="launchables_test", base_url=self.server.url)

    def reply(self, code, payload=None, headers=None):
        self.server.script.append((code, payload if payload is not None else {}, headers))

    def rows(self, i=0):
        return [json.loads(r) for r in self.server.requests[i]["body"].decode().splitlines()]


class CreateTests(Base):
    def test_create_sends_the_lines_as_jsonl_one_decide_body_per_line(self):
        self.reply(200, CREATED)
        made = self.client.batches.create([
            line("a"),
            line("b", model="myles-g-31b", questions={"team": choice("Which team?", ["billing", "other"])}),
        ])
        self.assertIsInstance(made, CreatedBatch)
        self.assertEqual((made.id, made.status, made.lines, made.data_region), (ID, "queued", 2, "CANADA-1 (Canada)"))
        self.assertEqual(made.estimated_cost.rate, 0.5)
        self.assertEqual(made.raw, CREATED)
        req = self.server.requests[0]
        self.assertEqual((req["method"], req["path"]), ("POST", "/v1/batches"))
        self.assertEqual(req["headers"]["Content-Type"], "application/jsonl")
        self.assertEqual(req["headers"]["Authorization"], "Bearer launchables_test")
        self.assertNotIn("Launchables-Webhook-Url", req["headers"])
        self.assertTrue(req["body"].endswith(b"\n"))
        rows = self.rows()
        self.assertEqual(rows[0], {"custom_id": "a", "model": "myles-g-12b", "state": "Charged twice for order 4471",
                                   "questions": {"refund": {"type": "noul", "instructions": "Is a refund due?"}}})
        self.assertEqual(rows[1]["model"], "myles-g-31b")

    def test_batch_is_create_and_a_webhook_goes_in_its_header(self):
        self.reply(200, CREATED)
        self.client.batch([line("a")], webhook_url="https://hooks.example.com/batches?team=ops")
        req = self.server.requests[0]
        self.assertEqual(req["path"], "/v1/batches")
        self.assertEqual(req["headers"]["Launchables-Webhook-Url"], "https://hooks.example.com/batches?team=ops")

    def test_a_newline_inside_a_state_stays_inside_its_line(self):
        body = to_jsonl([line("a", state="first\nsecond")])
        self.assertEqual(body.count(b"\n"), 1)
        self.assertEqual(json.loads(body)["state"], "first\nsecond")

    def test_images_are_sent_inline(self):
        self.reply(200, CREATED)
        self.client.batch([line("a", assets={"r": Image.from_bytes(PNG)}, image_budget=140)])
        row = self.rows()[0]
        self.assertEqual(row["assets"]["r"]["format"], "png")
        self.assertIsInstance(row["assets"]["r"]["data_base64"], str)
        self.assertEqual(row["image_budget"], 140)

    def test_create_refuses_before_sending(self):
        cases = [
            ("no lines", [], r"at least one line"),
            ("not a list", "a", r"at least one line"),
            ("a dict", {"custom_id": "a"}, r"at least one line"),
            ("not a dict", [None], r"line 1: must be a dict"),
            ("no model", [{k: v for k, v in line("a").items() if k != "model"}], r"line 1 \(custom_id a\): every line names its model"),
            ("empty model", [line("a", model="")], r"names its model"),
            ("bad custom_id", [line("has space")], r"line 1: custom_id must be"),
            ("long custom_id", [line("x" * 65)], r"custom_id must be"),
            ("trailing newline in custom_id", [line("a\n")], r"custom_id must be"),
            ("duplicate custom_id", [line("a"), line("a")], r"line 2 \(custom_id a\): custom_id is used on an earlier line"),
            ("list state", [line("a", state=[])], r"state must be a string or a JSON object"),
            ("no questions", [line("a", questions={})], r"line 1 \(custom_id a\): questions must be a non-empty dict"),
            ("bad question", [line("a", questions={"q": {"type": "maybe", "instructions": "x"}})], r"type must be one of"),
            ("file part image", [line("a", assets={"r": {"type": "image", "format": "png", "part": "r"}})], r"must be inline \(data_base64\)"),
            ("bad image budget", [line("a", image_budget=100)], r"image_budget must be one of"),
            ("not JSON", [line("a", state={"x": float("nan")})], r"line 1 \(custom_id a\): cannot be sent as JSON"),
        ]
        for name, lines, pattern in cases:
            with self.subTest(name):
                with self.assertRaisesRegex(ValidationError, pattern):
                    self.client.batches.create(lines)
        self.assertEqual(self.server.requests, [])

    def test_create_refuses_a_webhook_that_is_not_https_before_sending(self):
        with self.assertRaises(ValidationError):
            self.client.batches.create([line("a")], webhook_url="http://hooks.example.com")
        self.assertEqual(self.server.requests, [])

    def test_an_invalid_batch_is_refused_whole_with_every_bad_line_listed(self):
        errors = [{"line": 2, "type": "model_not_found", "error": "model 'x' not found"}]
        self.reply(422, {"error": "1 invalid line(s); nothing was queued", "type": "invalid_batch", "errors": errors,
                         "invalid_lines": 1})
        with self.assertRaises(InvalidRequestError) as cm:
            self.client.batches.create([line("a")])
        self.assertEqual(cm.exception.type, "invalid_batch")
        self.assertEqual(cm.exception.body["errors"], errors)

    def test_create_is_never_retried_after_a_lost_connection_or_a_502(self):
        self.server.script.append("drop")
        with self.assertRaises(APIConnectionError):
            self.client.batches.create([line("a")])
        self.assertEqual(len(self.server.requests), 1)
        self.reply(502, {"error": "bad gateway"})
        with self.assertRaises(APIError):
            self.client.batches.create([line("a")])
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.sleeps, [])

    def test_create_is_retried_after_a_refusal_that_stored_nothing(self):
        self.reply(429, {"error": "rate limit", "type": "rate_limited", "retry_after": 2}, {"Retry-After": "2"})
        self.reply(503, {"error": "busy", "type": "busy"})
        self.reply(200, CREATED)
        self.assertEqual(self.client.batches.create([line("a")]).id, ID)
        self.assertEqual(len(self.server.requests), 3)
        self.assertEqual(self.sleeps, [2.0, 1.0])

    def test_too_many_open_batches_is_raised_at_once_with_the_wait(self):
        self.reply(429, {"error": "at most 10 batches", "type": "too_many_batches", "retry_after": 300}, {"Retry-After": "300"})
        with self.assertRaises(RateLimitError) as cm:
            self.client.batches.create([line("a")])
        self.assertEqual((cm.exception.type, cm.exception.retry_after), ("too_many_batches", 300.0))
        self.assertEqual(len(self.server.requests), 1)

    def test_create_sends_one_idempotency_key_on_every_retry_and_a_callers_own(self):
        self.reply(429, {"error": "rate limit", "type": "rate_limited"}, {"Retry-After": "1"})
        self.reply(200, CREATED)
        self.reply(200, CREATED)
        self.client.batches.create([line("a")])
        self.client.batch([line("a")], idempotency_key="nightly-2026-10-25")
        keys = [r["headers"].get("Idempotency-Key") for r in self.server.requests]
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(len(keys[0]), 36)
        self.assertEqual(keys[2], "nightly-2026-10-25")
        with self.assertRaises(ValidationError):
            self.client.batches.create([line("a")], idempotency_key="")

    def test_create_waits_out_a_submission_still_in_progress(self):
        self.reply(409, {"error": "still being answered", "type": "idempotency_in_progress"}, {"Retry-After": "2"})
        self.reply(200, CREATED, {"Idempotent-Replayed": "true"})
        self.assertEqual(self.client.batches.create([line("a")], idempotency_key="b-1").id, ID)
        self.assertEqual(self.sleeps, [2.0])

    def test_a_503_without_busy_is_not_retried(self):
        self.reply(503, {"error": "maintenance"})
        with self.assertRaises(APIError):
            self.client.batches.create([line("a")])
        self.assertEqual(len(self.server.requests), 1)


class StatusTests(Base):
    def test_batch_unavailable_is_never_retried(self):
        self.reply(503, {"error": "the batch API is not available on this server", "type": "batch_unavailable",
                         "retry_after": 3600}, {"Retry-After": "3600"})
        with self.assertRaises(APIError) as cm:
            self.client.batches.list()
        self.assertEqual(cm.exception.type, "batch_unavailable")
        self.assertEqual(len(self.server.requests), 1)

    def test_list_retrieve_and_cancel(self):
        self.reply(200, {"object": "list", "data": [status("queued", counts(0, 0, 2))]})
        self.reply(200, status("running", counts(1, 0, 1)))
        self.reply(200, status("cancelled", counts(1, 0, 0)))
        listed = self.client.batches.list()
        self.assertIsInstance(listed[0], Batch)
        self.assertEqual(listed[0].id, ID)
        got = self.client.batches.retrieve(ID)
        self.assertEqual((got.status, got.counts.done, got.counts.pending, got.models), ("running", 1, 1, ["myles-g-12b"]))
        self.assertEqual(self.client.batches.cancel(ID).status, "cancelled")
        self.assertEqual([(r["method"], r["path"]) for r in self.server.requests], [
            ("GET", "/v1/batches"), ("GET", f"/v1/batches/{ID}"), ("POST", f"/v1/batches/{ID}/cancel"),
        ])
        self.assertEqual(self.server.requests[2]["body"], b"")

    def test_status_calls_are_retried_like_any_read(self):
        self.reply(502, {"error": "x"})
        self.reply(200, status("queued", counts(0, 0, 2)))
        self.assertEqual(self.client.batches.retrieve(ID).status, "queued")
        self.assertEqual(len(self.server.requests), 2)

    def test_ids_are_checked_before_sending_and_an_unknown_id_is_not_found(self):
        for bad in ("../v1/key", "", None, ID + "\n"):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                self.client.batches.retrieve(bad)
        with self.assertRaises(ValidationError):
            self.client.batches.cancel("")
        self.assertEqual(self.server.requests, [])
        self.reply(404, {"error": "batch not found", "type": "batch_not_found"})
        with self.assertRaises(NotFoundError) as cm:
            self.client.batches.retrieve(ID)
        self.assertEqual(cm.exception.type, "batch_not_found")

    def test_cancelling_a_finished_batch_is_a_conflict(self):
        self.reply(409, {"error": "the batch is already done", "type": "batch_finished"})
        with self.assertRaises(ConflictError) as cm:
            self.client.batches.cancel(ID)
        self.assertEqual(cm.exception.type, "batch_finished")

    def test_a_status_with_missing_fields_still_parses(self):
        b = parse_batch({"id": ID, "status": "queued"})
        self.assertEqual((b.lines, b.counts.done, b.models, b.estimated_cost.amount), (0, 0, [], 0.0))


class ResultsTests(Base):
    def test_one_per_input_line_in_order_answers_typed_as_decides(self):
        self.reply(200, jsonl(ANSWERED, EXPIRED), {"Content-Type": "application/jsonl"})
        a, b = self.client.batches.results(ID)
        req = self.server.requests[0]
        self.assertEqual(req["path"], f"/v1/batches/{ID}/results")
        self.assertEqual(req["headers"]["Accept"], "application/jsonl")
        self.assertIsInstance(a, AnsweredBatchResult)
        self.assertTrue(a.ok)
        self.assertEqual((a.custom_id, a.status, a.model), ("a", 200, "myles-g-12b-20261017"))
        self.assertIsInstance(a.response.answers["refund"], NoulAnswer)
        self.assertEqual(a.response.answers["refund"].decide(), "yes")
        self.assertEqual((a.usage.input_tokens, a.usage.output_tokens, a.usage.batch), (120, 1, True))
        self.assertIsNone(a.error)
        self.assertIsInstance(b, FailedBatchResult)
        self.assertFalse(b.ok)
        self.assertIsNone(b.status)
        self.assertEqual(b.error["type"], "expired")
        self.assertIsNone(b.response)
        self.assertEqual(b.raw, EXPIRED)

    def test_stream_results_yields_one_at_a_time_and_stops_early(self):
        self.reply(200, jsonl(ANSWERED, EXPIRED, dict(ANSWERED, custom_id="c")))
        seen = []
        for r in self.client.batches.stream_results(ID):
            seen.append(r.custom_id)
            if len(seen) == 2:
                break
        self.assertEqual(seen, ["a", "b"])

    def test_a_results_file_without_a_final_newline_still_gives_its_last_line(self):
        self.reply(200, json.dumps(ANSWERED).encode())
        self.assertEqual(len(self.client.batches.results(ID)), 1)

    def test_results_before_the_batch_ends_is_a_conflict(self):
        self.reply(409, {"error": "the batch is running; results are ready once it is done", "type": "batch_not_finished"})
        with self.assertRaises(ConflictError) as cm:
            self.client.batches.results(ID)
        self.assertEqual(cm.exception.type, "batch_not_finished")

    def test_an_answer_this_client_cannot_read_stays_in_raw_as_an_unanswered_line(self):
        odd = dict(ANSWERED, response={"model": "m", "answers": {"q": {"type": "future"}}})
        self.reply(200, jsonl(odd))
        [r] = self.client.batches.results(ID)
        self.assertFalse(r.ok)
        self.assertEqual(r.error["type"], "unreadable_answer")
        self.assertEqual(r.raw, odd)

    def test_a_line_that_is_not_json_is_an_error(self):
        self.reply(200, b"{not json}\n")
        with self.assertRaises(LaunchablesError):
            self.client.batches.results(ID)


def ago(seconds):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)).isoformat()


class WaitForTests(Base):
    def test_polls_with_growing_waits_until_the_batch_is_done(self):
        self.reply(200, status("queued", counts(0, 0, 2)))
        self.reply(200, status("running", counts(1, 0, 1)))
        self.reply(200, status("running", counts(1, 0, 1)))
        self.reply(200, status("done", counts(2, 0, 0)))
        polled = []
        done = self.client.batches.wait_for(ID, on_poll=lambda b: polled.append(b.status))
        self.assertEqual(done.status, "done")
        self.assertEqual(len(self.server.requests), 4)
        self.assertEqual(self.sleeps, [5.0, 7.5, 11.25])
        self.assertEqual(polled, ["queued", "running", "running", "done"])

    def test_stops_growing_the_wait_at_max_interval(self):
        for _ in range(5):
            self.reply(200, status("running", counts(0, 0, 2)))
        self.reply(200, status("failed", counts(0, 2, 0)))
        self.client.batches.wait_for(ID, poll_interval=1, max_interval=2)
        self.assertEqual(self.sleeps, [1.0, 1.5, 2.0, 2.0, 2.0])

    def test_the_first_wait_is_capped_by_max_interval(self):
        self.reply(200, status("running", counts(0, 0, 2)))
        self.reply(200, status("done", counts(2, 0, 0)))
        self.client.batches.wait_for(ID, poll_interval=60, max_interval=2)
        self.assertEqual(self.sleeps, [2.0])

    def test_a_cancelled_batch_waits_for_the_lines_still_in_progress(self):
        self.reply(200, status("cancelled", counts(1, 0, 0), lines=3, finished_at=ago(0)))
        self.reply(200, status("cancelled", counts(2, 1, 0), lines=3, finished_at=ago(0)))
        self.assertEqual(self.client.batches.wait_for(ID).counts.done, 2)
        self.assertEqual(len(self.server.requests), 2)

    def test_a_cancelled_batch_whose_counts_never_add_up_is_finished_10_minutes_after_the_cancel(self):
        self.reply(200, status("cancelled", counts(1, 0, 0), lines=3, finished_at=ago(11 * 60)))
        self.assertEqual(self.client.batches.wait_for(ID).status, "cancelled")
        self.assertEqual(len(self.server.requests), 1)

    def test_finished_reads_z_times(self):
        b = parse_batch(status("cancelled", counts(0, 0, 0), lines=3, finished_at="2020-01-01T00:00:00Z"))
        self.assertTrue(finished(b))
        b = parse_batch(status("cancelled", counts(0, 0, 0), lines=3, finished_at=ago(0).replace("+00:00", "Z")))
        self.assertFalse(finished(b))

    def test_gives_up_after_its_timeout_leaving_the_batch_running(self):
        self.reply(200, status("running", counts(0, 0, 2)))
        with mock.patch.object(client_module, "_sleep", lambda s: time.sleep(min(s, 0.2))):
            with self.assertRaises(BatchTimeoutError) as cm:
                self.client.batches.wait_for(ID, timeout=0.1)
        self.assertEqual(cm.exception.batch.status, "running")
        self.assertEqual(len(self.server.requests), 1)

    def test_the_timeout_also_shortens_a_status_request_in_flight(self):
        hang = threading.Event()
        self.addCleanup(hang.set)

        class Slow(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                hang.wait(10)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
        threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        client = Launchables(api_key="launchables_test", base_url=f"http://127.0.0.1:{httpd.server_address[1]}")
        t0 = time.monotonic()
        with self.assertRaises(BatchTimeoutError) as cm:
            client.batches.wait_for(ID, timeout=0.3)
        self.assertIsNone(cm.exception.batch)
        self.assertLess(time.monotonic() - t0, 5)

    def test_stop_ends_the_wait_without_cancelling_the_batch(self):
        stop = threading.Event()
        self.reply(200, status("running", counts(0, 0, 2)))
        with self.assertRaises(BatchWaitCancelledError) as cm:
            self.client.batches.wait_for(ID, stop=stop, on_poll=lambda b: stop.set())
        self.assertEqual(cm.exception.batch.status, "running")
        self.assertEqual([r["path"] for r in self.server.requests], [f"/v1/batches/{ID}"])

    def test_stop_set_from_another_thread_ends_a_wait_in_progress(self):
        stop = threading.Event()
        self.reply(200, status("running", counts(0, 0, 2)))
        threading.Timer(0.05, stop.set).start()
        t0 = time.monotonic()
        with self.assertRaises(BatchWaitCancelledError):
            self.client.batches.wait_for(ID, stop=stop)  # the first wait is 5 s
        self.assertLess(time.monotonic() - t0, 2)

    def test_stop_also_ends_the_clients_own_retry_waits(self):
        stop = threading.Event()
        self.reply(429, {"error": "rate limit", "type": "rate_limited"}, {"Retry-After": "60"})
        self.reply(200, status("done", counts(2, 0, 0)))
        threading.Timer(0.05, stop.set).start()
        t0 = time.monotonic()
        with self.assertRaises(BatchWaitCancelledError) as cm:
            self.client.batches.wait_for(ID, stop=stop)
        self.assertIsNone(cm.exception.batch)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual(len(self.server.requests), 1)

    def test_a_stop_already_set_sends_nothing(self):
        stop = threading.Event()
        stop.set()
        with self.assertRaises(BatchWaitCancelledError):
            self.client.batches.wait_for(ID, stop=stop)
        self.assertEqual(self.server.requests, [])

    def test_refuses_intervals_that_are_not_numbers_of_seconds(self):
        for kw in ({"poll_interval": -1}, {"poll_interval": 0.999}, {"max_interval": 0}, {"timeout": float("nan")},
                   {"timeout": -1}, {"poll_interval": True}, {"timeout": "1"}):
            with self.subTest(kw), self.assertRaises(ValueError):
                self.client.batches.wait_for(ID, **kw)
        self.assertEqual(self.server.requests, [])

    def test_keeps_waiting_through_an_outage_longer_than_the_clients_own_retries(self):
        for _ in range(4):  # 1 try + 3 retries: one failed poll
            self.reply(502, {"error": "bad gateway"})
        for _ in range(4):
            self.server.script.append("drop")
        self.reply(200, status("done", counts(2, 0, 0)))
        self.assertEqual(self.client.batches.wait_for(ID).status, "done")
        self.assertEqual(len(self.server.requests), 9)

    def test_does_not_wait_through_errors_that_will_not_pass(self):
        self.reply(503, {"error": "the batch API is not available on this server", "type": "batch_unavailable"})
        with self.assertRaises(APIError) as cm:
            self.client.batches.wait_for(ID)
        self.assertEqual(cm.exception.type, "batch_unavailable")
        self.reply(404, {"error": "batch not found", "type": "batch_not_found"})
        with self.assertRaises(NotFoundError):
            self.client.batches.wait_for(ID)


if __name__ == "__main__":
    unittest.main()
