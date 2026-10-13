"""Repeatable local API/WebSocket checks: run with python smoke_test.py."""
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

TEST_DIR = tempfile.TemporaryDirectory(prefix="neurofocus-smoke-")
os.environ["ENVIRONMENT"] = "development"
os.environ["NEUROFOCUS_SECRET"] = "smoke-test-only-secret"
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(TEST_DIR.name, "smoke.db").replace("\\", "/")

from fastapi.testclient import TestClient
import main


class NeuroFocusSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.suffix = uuid.uuid4().hex[:10]
        cls.hr_email = f"hr-{cls.suffix}@example.com"
        cls.candidate_email = f"candidate-{cls.suffix}@example.com"
        cls.hr = cls.client.post("/api/register", json={"name": "HR Demo", "email": cls.hr_email, "password": "TestPass123", "role": "hr"})
        cls.candidate = cls.client.post("/api/register", json={"name": "Candidate Demo", "email": cls.candidate_email, "password": "TestPass123", "role": "candidate"})

    def test_health_and_frontend(self):
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        page = self.client.get("/room.html")
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers.get("cache-control"), "no-store")
        self.assertIn("Starting your camera", page.text)
        script = self.client.get("/static/room.js")
        self.assertEqual(script.status_code, 200)
        self.assertEqual(script.headers.get("cache-control"), "no-store")
        self.assertIn("attachLocalVideo", script.text)
        revalidated = self.client.get("/static/room.js", headers={"If-None-Match": '"stale-browser-copy"'})
        self.assertEqual(revalidated.status_code, 200)

    def test_registration_login_and_jwt(self):
        self.assertEqual(self.hr.status_code, 200, self.hr.text)
        self.assertEqual(self.candidate.status_code, 200, self.candidate.text)
        self.assertEqual(self.client.post("/api/register", json={"name": "HR Demo", "email": self.hr_email, "password": "TestPass123", "role": "hr"}).status_code, 409)
        self.assertEqual(self.client.post("/api/register", json={"name": "Short", "email": f"short-{self.suffix}@example.com", "password": "short", "role": "hr"}).status_code, 422)
        self.assertEqual(self.client.post("/api/login", json={"email": self.hr_email, "password": "wrong"}).status_code, 401)
        login = self.client.post("/api/login", json={"email": self.hr_email, "password": "TestPass123"})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.json()["role"], "hr")
        identity = self.client.get("/api/me", headers={"Authorization": f"Bearer {login.json()['token']}"})
        self.assertEqual(identity.status_code, 200)
        self.assertEqual(identity.json()["email"], self.hr_email)
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_production_hr_invite_requirement(self):
        was_production = main.IS_PRODUCTION
        prior_code = os.environ.get("NEUROFOCUS_HR_INVITE_CODE")
        os.environ["NEUROFOCUS_HR_INVITE_CODE"] = "review-only-test-code"
        main.IS_PRODUCTION = True
        try:
            base = {"name": "Invited HR", "password": "TestPass123", "role": "hr"}
            missing = self.client.post("/api/register", json={**base, "email": f"invite-missing-{self.suffix}@example.com"})
            self.assertEqual(missing.status_code, 403)
            accepted = self.client.post("/api/register", json={**base, "email": f"invite-valid-{self.suffix}@example.com", "hr_invite_code": "review-only-test-code"})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            candidate = self.client.post("/api/register", json={"name": "Open Candidate", "email": f"invite-candidate-{self.suffix}@example.com", "password": "TestPass123", "role": "candidate"})
            self.assertEqual(candidate.status_code, 200, candidate.text)
        finally:
            main.IS_PRODUCTION = was_production
            if prior_code is None:
                os.environ.pop("NEUROFOCUS_HR_INVITE_CODE", None)
            else:
                os.environ["NEUROFOCUS_HR_INVITE_CODE"] = prior_code

    def test_ice_config_is_stun_only_without_secrets(self):
        os.environ.pop("NEUROFOCUS_TURN_URLS", None)
        os.environ.pop("NEUROFOCUS_TURN_USERNAME", None)
        os.environ.pop("NEUROFOCUS_TURN_CREDENTIAL", None)
        self.assertEqual(self.client.get("/api/config/ice-servers").status_code, 401)
        login = self.client.post("/api/login", json={"email": self.hr_email, "password": "TestPass123"})
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        result = self.client.get("/api/config/ice-servers", headers=headers).json()
        self.assertFalse(result["turnConfigured"])
        self.assertEqual(len(result["iceServers"]), 1)

    def test_production_requires_jwt_secret(self):
        env = os.environ.copy()
        env["ENVIRONMENT"] = "production"
        env.pop("RENDER", None)
        env.pop("NEUROFOCUS_SECRET", None)
        result = subprocess.run([sys.executable, "-c", "import main"], cwd=os.path.dirname(__file__), env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NEUROFOCUS_SECRET must be configured in production", result.stderr)

    def test_rooms_events_questions_answers_and_role_limit(self):
        self.assertEqual(self.hr.status_code, 200, self.hr.text)
        self.assertEqual(self.candidate.status_code, 200, self.candidate.text)
        hr_headers = {"Authorization": f"Bearer {self.hr.json()['token']}"}
        candidate_headers = {"Authorization": f"Bearer {self.candidate.json()['token']}"}
        self.assertEqual(self.client.post("/api/rooms", headers=candidate_headers, json={}).status_code, 403)
        created = self.client.post("/api/rooms", headers=hr_headers, json={})
        self.assertEqual(created.status_code, 200, created.text)
        room = created.json()["room"]
        self.assertRegex(room, r"^NF-[A-HJ-NP-Z2-9]{6}$")
        self.assertEqual(self.client.post("/api/rooms", json={}).status_code, 401)
        with self.client.websocket_connect(f"/ws/NF-ABCDEF?token={self.hr.json()['token']}") as invalid_ws:
            self.assertEqual(invalid_ws.receive_json()["event"], "invalid_room")
        with self.client.websocket_connect(f"/ws/{room}?token={self.hr.json()['token']}") as hr_ws:
            self.assertEqual(hr_ws.receive_json()["event"], "room_state")
            time.sleep(15)  # Reproduce the reported delayed-candidate join.
            with self.client.websocket_connect(f"/ws/{room}?token={self.candidate.json()['token']}") as candidate_ws:
                candidate_state = candidate_ws.receive_json()
                self.assertEqual(candidate_state["event"], "room_state")
                self.assertEqual(candidate_state["peers"][0]["role"], "hr")
                self.assertEqual(hr_ws.receive_json()["event"], "peer_joined")
                candidate_ws.send_json({"type": "chat", "text": "Hello from candidate"})
                chat = hr_ws.receive_json()
                self.assertEqual(chat["from"], "Candidate Demo")
                self.assertEqual(chat["role"], "candidate")
                candidate_ws.send_json({"type": "room_event", "event": "candidate_tab_hidden"})
                event = hr_ws.receive_json()
                self.assertEqual(event["type"], "room_event")
                self.assertEqual(event["event"], "candidate_tab_hidden")
                candidate_ws.send_json({"type": "room_event", "event": "hr_camera_off"})
                candidate_ws.send_json({"type": "room_event", "event": "candidate_camera_off"})
                candidate_camera = hr_ws.receive_json()
                self.assertEqual(candidate_camera["event"], "candidate_camera_off")
                hr_ws.send_json({"type": "room_event", "event": "hr_camera_off"})
                hr_camera = candidate_ws.receive_json()
                self.assertEqual(hr_camera["event"], "hr_camera_off")
                hr_ws.send_json({"type": "question", "category": "coding", "text": "Reverse a string"})
                question = candidate_ws.receive_json()
                self.assertEqual(question["type"], "question")
                self.assertEqual(question["category"], "coding")
                candidate_ws.send_json({"type": "answer", "question_id": "not-issued", "format": "code", "text": "forged"})
                candidate_ws.send_json({"type": "answer", "question_id": question["id"], "format": "code", "language": "python", "text": "return s[::-1]"})
                answer = hr_ws.receive_json()
                self.assertEqual(answer["type"], "answer")
                self.assertEqual(answer["text"], "return s[::-1]")
                self.assertEqual(answer["language"], "python")
                candidate_ws.send_json({"type": "answer", "question_id": question["id"], "format": "code", "language": "python", "text": "duplicate"})
                candidate_ws.send_json({"type": "renegotiate_request"})
                ordinary_renegotiation = hr_ws.receive_json()
                self.assertEqual(ordinary_renegotiation["type"], "renegotiate_request")
                self.assertFalse(ordinary_renegotiation["restart_ice"])
                candidate_ws.send_json({"type": "renegotiate_request", "restart_ice": True})
                ice_restart = hr_ws.receive_json()
                self.assertEqual(ice_restart["type"], "renegotiate_request")
                self.assertTrue(ice_restart["restart_ice"])
                with self.client.websocket_connect(f"/ws/{room}?token={self.hr.json()['token']}") as extra_ws:
                    self.assertEqual(extra_ws.receive_json()["event"], "room_full")
            self.assertEqual(hr_ws.receive_json()["event"], "peer_left")

        reverse_room = self.client.post("/api/rooms", headers=hr_headers, json={}).json()["room"]
        with self.client.websocket_connect(f"/ws/{reverse_room}?token={self.candidate.json()['token']}") as candidate_ws:
            self.assertEqual(candidate_ws.receive_json()["event"], "room_state")
            with self.client.websocket_connect(f"/ws/{reverse_room}?token={self.hr.json()['token']}") as hr_ws:
                hr_state = hr_ws.receive_json()
                self.assertEqual(hr_state["event"], "room_state")
                self.assertEqual(hr_state["peers"][0]["role"], "candidate")
                self.assertEqual(candidate_ws.receive_json()["event"], "peer_joined")
            self.assertEqual(candidate_ws.receive_json()["event"], "peer_left")

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        main.engine.dispose()
        TEST_DIR.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
