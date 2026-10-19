"""Generates fixtures/claude/<scenario>.jsonl in the Claude Code 2.1.303
stream-json envelope. Hand-authored content, realistic usage/cost figures."""
import json, uuid, pathlib

OUT = pathlib.Path("fixtures/claude")
MODEL_OPUS = "claude-opus-5-5"
MODEL_SONNET = "claude-sonnet-5-5"

def usage(i, o, cr=0, cw=0):
    return {"input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr,
            "cache_creation_input_tokens": cw, "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
            "service_tier": "standard"}

class Scenario:
    def __init__(self, name, model, tools, permission_mode):
        self.name, self.model, self.tools, self.permission_mode = name, model, tools, permission_mode
        self.sid = str(uuid.uuid5(uuid.NAMESPACE_URL, "mates/" + name))
        self.lines = []
        self.tot = {"i": 0, "o": 0, "cr": 0, "cw": 0}
        self.turns = 0
        self.lines.append({"type": "system", "subtype": "init", "cwd": "/workspace/repo", "session_id": self.sid,
                           "tools": tools, "mcp_servers": [], "model": model, "permissionMode": permission_mode,
                           "apiKeySource": "ANTHROPIC_API_KEY", "claude_code_version": "2.1.303", "output_style": "default"})

    def _msg(self, content, i, o, cr=0, cw=0):
        self.turns += 1
        self.tot["i"] += i; self.tot["o"] += o; self.tot["cr"] += cr; self.tot["cw"] += cw
        self.lines.append({"type": "assistant", "message": {"id": "msg_" + uuid.uuid4().hex[:24], "type": "message",
                           "role": "assistant", "model": self.model, "content": content, "stop_reason": "end_turn",
                           "stop_sequence": None, "usage": usage(i, o, cr, cw)},
                           "parent_tool_use_id": None, "session_id": self.sid, "uuid": str(uuid.uuid4())})

    def text(self, t, i=1200, o=80, cr=4000):
        self._msg([{"type": "text", "text": t}], i, o, cr)

    def tool(self, name, inp, result, i=900, o=120, cr=6000, cw=0):
        tid = "toolu_" + uuid.uuid4().hex[:24]
        self._msg([{"type": "tool_use", "id": tid, "name": name, "input": inp}], i, o, cr, cw)
        self.lines.append({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": result}]},
            "parent_tool_use_id": None, "session_id": self.sid, "uuid": str(uuid.uuid4())})

    def api_retry(self, attempt):
        self.lines.append({"type": "system", "subtype": "api_retry", "attempt": attempt, "max_attempts": 10,
                           "delay_ms": 1000 * attempt, "error": "overloaded_error", "session_id": self.sid})

    def result(self, text, cost, is_error=False, structured=None, subtype="success", denials=None):
        r = {"type": "result", "subtype": subtype, "is_error": is_error, "duration_ms": 180000 + 1000 * self.turns,
             "duration_api_ms": 150000, "num_turns": self.turns, "result": text, "session_id": self.sid,
             "total_cost_usd": cost, "usage": usage(self.tot["i"], self.tot["o"], self.tot["cr"], self.tot["cw"]),
             "modelUsage": {self.model: {"inputTokens": self.tot["i"], "outputTokens": self.tot["o"],
                                        "cacheReadInputTokens": self.tot["cr"], "cacheCreationInputTokens": self.tot["cw"],
                                        "webSearchRequests": 0, "costUSD": cost, "contextWindow": 200000}},
             "permission_denials": denials or [], "uuid": str(uuid.uuid4())}
        if structured is not None:
            r["structured_output"] = structured
        self.lines.append(r)

    def write(self):
        (OUT / f"{self.name}.jsonl").write_text("\n".join(json.dumps(l) for l in self.lines) + "\n")

RO = ["Read", "Glob", "Grep", "Bash"]
RW = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]

# intake_implementable
s = Scenario("intake_implementable", MODEL_SONNET, RO, "dontAsk")
s.text("Reading the ticket and the repository map.")
s.tool("Read", {"file_path": "/context/ticket.json"}, "{...ticket...}")
s.tool("Read", {"file_path": "/context/team/docs/conventions.md"}, "# Conventions ...")
s.tool("Bash", {"command": "git ls-files src tests"}, "src/webhook/retry.py\ntests/test_retry.py")
s.text("The ticket is implementable in webhook-service: cap retries at 5 attempts within 10 minutes and add a dead-letter path.")
s.result("Ticket is implementable as written.", 0.0412, structured={
    "decision": "implementable", "repo_id": "webhook-service", "base_branch": "main",
    "plan": ["Add a max_attempts ceiling to RetryPolicy", "Cap the backoff window at 10 minutes", "Add tests for the ceiling and the dead-letter path"],
    "questions": [], "reasoning_summary": "Single repo (webhook-service owns retries); acceptance criteria are explicit."})
s.write()

# intake_needs_clarification
s = Scenario("intake_needs_clarification", MODEL_SONNET, RO, "dontAsk")
s.tool("Read", {"file_path": "/context/ticket.json"}, "{...ticket...}")
s.text("The ticket gives two contradictory limits for the free tier.")
s.result("Needs clarification.", 0.0188, structured={
    "decision": "needs_clarification", "repo_id": None, "base_branch": None, "plan": [],
    "questions": ["The ticket lists both 100 req/min and 1 000 req/min. Which applies to the free tier?"],
    "reasoning_summary": "Acceptance criteria contradict each other on the rate limit."})
s.write()

# impl_iter1_green
s = Scenario("impl_iter1_green", MODEL_OPUS, RW, "acceptEdits")
s.tool("Read", {"file_path": "/context/team/docs/conventions.md"}, "# Conventions ...")
s.tool("Read", {"file_path": "src/webhook/retry.py"}, "class RetryPolicy: ...")
s.tool("Edit", {"file_path": "src/webhook/retry.py", "old_string": "def __init__(self, base_seconds: float = 1.0) -> None:\n        self.base_seconds = base_seconds",
                 "new_string": "def __init__(self, base_seconds: float = 1.0, max_attempts: int = 5) -> None:\n        self.base_seconds = base_seconds\n        self.max_attempts = max_attempts"}, "Edited", i=2000, o=300)
s.tool("Edit", {"file_path": "tests/test_retry.py", "old_string": "if __name__", "new_string": "def test_stops_at_max_attempts(self):\n        ...\n\nif __name__"}, "Edited", i=2100, o=260)
s.tool("Bash", {"command": "python3 -m unittest discover -s tests -v"},
       "test_delay_doubles ... ok\ntest_rejects_zero_attempt ... ok\ntest_stops_at_max_attempts ... ok\n\nRan 3 tests in 0.002s\n\nOK\n", i=2300, o=90)
s.text("Added a max_attempts ceiling to RetryPolicy with a test; the suite is green.\n\n```json\n{\"addressed\": [], \"skipped\": [], \"summary\": \"Cap retry attempts at five\"}\n```", i=2400, o=140)
s.result("Implemented the retry ceiling.", 1.8734)
s.write()

# impl_iter2_addressed
s = Scenario("impl_iter2_addressed", MODEL_OPUS, RW, "acceptEdits")
s.tool("Read", {"file_path": "/context/brief.md"}, "# Task — iteration 2 ...")
s.tool("Read", {"file_path": "src/webhook/retry.py"}, "class RetryPolicy: ...")
s.tool("Edit", {"file_path": "src/webhook/retry.py", "old_string": "return self.base_seconds * (2 ** (attempt - 1))", "new_string": "return min(self.base_seconds * (2 ** (attempt - 1)), MAX_WINDOW_SECONDS)"}, "Edited", i=2600, o=240)
s.tool("Write", {"file_path": "tests/test_retry.py", "content": "import unittest\n..."}, "Wrote", i=2700, o=400)
s.tool("Bash", {"command": "python3 -m unittest discover -s tests -v"},
       "test_delay_doubles ... ok\ntest_delay_is_capped ... ok\ntest_exhausted_delivery_goes_to_dead_letter ... ok\ntest_rejects_zero_attempt ... ok\ntest_stops_at_max_attempts ... ok\n\nRan 5 tests in 0.003s\n\nOK\n", i=2900, o=90)
s.text("Capped the backoff window (B1) and added the dead-letter path with a test (B2). N3 skipped: renaming the module is out of scope.\n\n```json\n{\"addressed\": [\"B1\", \"B2\"], \"skipped\": [{\"id\": \"N3\", \"reason\": \"module rename is out of scope for this ticket\"}], \"summary\": \"Cap backoff window and add dead-letter path\"}\n```", i=3000, o=180)
s.result("Addressed B1 and B2.", 2.3105)
s.write()

# review_changes_requested_2_blocking
s = Scenario("review_changes_requested_2_blocking", MODEL_OPUS, RO, "dontAsk")
s.tool("Read", {"file_path": "/context/diff.patch"}, "diff --git ...")
s.tool("Read", {"file_path": "/context/tests.log"}, "Ran 3 tests ... OK")
s.tool("Read", {"file_path": "src/webhook/retry.py"}, "class RetryPolicy: ...")
s.text("Two acceptance criteria are not met yet.")
s.result("Changes requested.", 0.9321, structured={
    "decision": "changes_requested",
    "blocking": [
        {"id": "B1", "title": "Backoff is unbounded", "detail": "The ticket caps retries at 5 attempts within 10 minutes; RetryPolicy.delay keeps doubling with no ceiling.", "file": "src/webhook/retry.py", "line": 14},
        {"id": "B2", "title": "No test covers the dead-letter path", "detail": "Exhausted deliveries must land in the dead-letter queue; nothing asserts it.", "file": "tests/test_retry.py", "line": None}],
    "non_blocking": [
        {"id": "N1", "title": "Docstring could mention the window", "detail": "State the 10-minute window in the class docstring.", "file": "src/webhook/retry.py", "line": 7},
        {"id": "N2", "title": "Prefer a module constant for the window", "detail": "A named constant reads better than a literal.", "file": "src/webhook/retry.py", "line": 1},
        {"id": "N3", "title": "Consider renaming the module", "detail": "retry.py could become backoff.py for clarity.", "file": None, "line": None}],
    "verified": {"tests_run": True, "acceptance_criteria": [
        {"text": "Retries capped at 5 attempts", "met": True},
        {"text": "All attempts within 10 minutes", "met": False},
        {"text": "Exhausted deliveries go to the dead-letter queue", "met": False}]},
    "summary": "The attempt ceiling is in place and tested. The 10-minute window is not enforced and the dead-letter path has no test; both block."})
s.write()

# review_approve
s = Scenario("review_approve", MODEL_OPUS, RO, "dontAsk")
s.tool("Read", {"file_path": "/context/diff.patch"}, "diff --git ...")
s.tool("Read", {"file_path": "/context/prior_verdicts.json"}, "[...]")
s.tool("Bash", {"command": "python3 -m unittest discover -s tests -v"}, "Ran 5 tests in 0.003s\n\nOK\n")
s.text("B1 and B2 are resolved; the suite is green.")
s.result("Approved.", 0.8117, structured={
    "decision": "approve", "blocking": [],
    "non_blocking": [{"id": "N1", "title": "Docstring could mention the window", "detail": "Still optional.", "file": "src/webhook/retry.py", "line": 7}],
    "verified": {"tests_run": True, "acceptance_criteria": [
        {"text": "Retries capped at 5 attempts", "met": True},
        {"text": "All attempts within 10 minutes", "met": True},
        {"text": "Exhausted deliveries go to the dead-letter queue", "met": True}]},
    "summary": "Retry attempts are capped at five within a ten-minute window and exhausted deliveries are marked for the dead-letter queue, each covered by a unit test. The previous blocking points B1 and B2 are resolved."})
s.write()

# impl_empty_diff
s = Scenario("impl_empty_diff", MODEL_OPUS, RW, "acceptEdits")
s.tool("Read", {"file_path": "src/webhook/retry.py"}, "class RetryPolicy: ...")
s.text("The requested behaviour already exists; no changes are needed.\n\n```json\n{\"addressed\": [], \"skipped\": [], \"summary\": \"No changes required\"}\n```")
s.result("No changes made.", 0.4402)
s.write()

# impl_budget_exceeded
s = Scenario("impl_budget_exceeded", MODEL_OPUS, RW, "acceptEdits")
s.tool("Read", {"file_path": "src/webhook/retry.py"}, "class RetryPolicy: ...", i=40000, o=800, cr=120000)
s.tool("Grep", {"pattern": "RetryPolicy", "path": "."}, "src/webhook/retry.py:4", i=45000, o=600, cr=130000)
s.result("Budget limit exceeded: $5.02 spent of $5.00 maximum", 5.0213, is_error=True, subtype="error_max_budget_usd")
s.write()

# api_retry_then_success (intake-shaped)
s = Scenario("api_retry_then_success", MODEL_SONNET, RO, "dontAsk")
s.api_retry(1)
s.api_retry(2)
s.tool("Read", {"file_path": "/context/ticket.json"}, "{...ticket...}")
s.text("Implementable.")
s.result("Ticket is implementable as written.", 0.0301, structured={
    "decision": "implementable", "repo_id": "webhook-service", "base_branch": "main",
    "plan": ["Add a max_attempts ceiling to RetryPolicy"], "questions": [], "reasoning_summary": "Single repo, clear criteria."})
s.write()
print(sorted(p.name for p in OUT.iterdir()))
