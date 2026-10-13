// Shared helpers: auth storage, API calls. Loaded on every page.

const API_BASE = window.location.origin;
const AUTH_KEY = "neurofocus_auth";

function saveAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

function getAuth() {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { clearAuth(); return null; }
}

function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

function requireAuth() {
  const auth = getAuth();
  if (!auth || !auth.token) {
    window.location.href = "/login.html";
    return null;
  }
  return auth;
}

function logout() {
  clearAuth();
  window.location.href = "/index.html";
}

async function apiPost(path, body) {
  const auth = getAuth();
  const headers = { "Content-Type": "application/json" };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join("; ") : data.detail;
    if (res.status === 401 && auth?.token && path !== "/api/login" && path !== "/api/register") {
      clearAuth();
      window.location.replace("/login.html?reason=session-expired");
      throw new Error("Your sign-in expired. Sign in again to continue.");
    }
    throw new Error(detail || "Request failed");
  }
  return data;
}

function setActiveNav() {
  const auth = getAuth();
  const el = document.getElementById("nav-session");
  if (!el) return;
  el.replaceChildren();
  if (auth) {
    const pill = document.createElement("span");
    pill.className = "session-pill";
    const dot = document.createElement("span");
    dot.className = "session-dot";
    pill.append(dot, document.createTextNode(`${auth.name} · ${auth.role.toUpperCase()}`));
    const button = document.createElement("button");
    button.className = "button tertiary small";
    button.textContent = "Sign out";
    button.addEventListener("click", logout);
    el.append(pill, button);
  } else {
    const link = document.createElement("a");
    link.href = "/login.html";
    link.textContent = "Sign in";
    link.className = "button secondary small";
    el.append(link);
  }
}
