const apiBase = (typeof window !== "undefined" && window.JD_API_BASE ? String(window.JD_API_BASE) : "")
  .trim()
  .replace(/\/+$/, "");
const apiUrl = (path) => (apiBase ? `${apiBase}${path}` : path);

const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const otpCodeInput = document.getElementById("otpCode");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authMsg = document.getElementById("authMsg");

const setup2faBtn = document.getElementById("setup2faBtn");
const enable2faBtn = document.getElementById("enable2faBtn");
const disable2faBtn = document.getElementById("disable2faBtn");
const twoFaSecretInput = document.getElementById("twoFaSecret");
const twoFaCodeInput = document.getElementById("twoFaCode");
const twoFaUriEl = document.getElementById("twoFaUri");
const twoFaQr = document.getElementById("twoFaQr");
const twoFaMsg = document.getElementById("twoFaMsg");
const securityCard = document.getElementById("securityCard");
const protectedArea = document.getElementById("protectedArea");

const statusFilter = document.getElementById("statusFilter");
const loadBtn = document.getElementById("loadBtn");
const rows = document.getElementById("rows");
const msg = document.getElementById("msg");
const auditRows = document.getElementById("auditRows");

const statusOptions = [
  { value: "new", label: "جديد" },
  { value: "contacted", label: "تم التواصل" },
  { value: "closed", label: "مغلق" }
];
const tokenStorageKey = "jd_admin_tokens";
const auditActionLabels = {
  admin_login_success: "دخول ناجح",
  admin_login_failed_unknown_user: "فشل الدخول: مستخدم غير معروف",
  admin_login_failed_password: "فشل الدخول: كلمة مرور خاطئة",
  admin_login_failed_2fa: "فشل الدخول: رمز 2FA خاطئ",
  admin_login_locked_by_failures: "تم قفل الحساب بسبب محاولات خاطئة",
  admin_login_locked_by_2fa_failures: "تم قفل الحساب بسبب فشل 2FA",
  admin_login_blocked_locked: "محاولة دخول أثناء القفل",
  admin_login_blocked_inactive: "محاولة دخول لحساب معطل",
  admin_token_refreshed: "تجديد جلسة الدخول",
  admin_2fa_setup_requested: "بدء إعداد 2FA",
  admin_2fa_enabled: "تم تفعيل 2FA",
  admin_2fa_disabled: "تم تعطيل 2FA",
  admin_2fa_enable_failed: "فشل تفعيل 2FA",
  admin_2fa_disable_failed: "فشل تعطيل 2FA",
  admin_lead_status_updated: "تحديث حالة طلب"
};

if (!apiBase) {
  loginBtn.disabled = true;
  logoutBtn.disabled = true;
  loadBtn.disabled = true;
  setup2faBtn.disabled = true;
  enable2faBtn.disabled = true;
  disable2faBtn.disabled = true;
  setAuthenticatedUI(false);
  setAuthMessage(
    "لم يتم ضبط API. عدّل `config.js` واجعل `window.JD_API_BASE` = `https://<project-ref>.supabase.co/functions/v1` ثم ادفع التغييرات ليُعاد نشر GitHub Pages.",
    true
  );
}

document.querySelectorAll(".toggle-visibility").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.getAttribute("data-target");
    if (!targetId) return;
    const input = document.getElementById(targetId);
    if (!(input instanceof HTMLInputElement)) return;
    input.type = input.type === "password" ? "text" : "password";
  });
});

function getStatusLabel(value) {
  const item = statusOptions.find((s) => s.value === value);
  return item ? item.label : value;
}

function getAuditLabel(action) {
  return auditActionLabels[action] || action;
}

function renderQrCode(text) {
  if (!twoFaQr) return;
  twoFaQr.innerHTML = "";
  if (!text || typeof QRCode === "undefined") return;
  new QRCode(twoFaQr, {
    text,
    width: 170,
    height: 170,
    colorDark: "#1c160f",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

function setMessage(text, isError = false) {
  msg.textContent = text;
  msg.style.color = isError ? "#b42318" : "#72604a";
}

function setAuthMessage(text, isError = false) {
  authMsg.textContent = text;
  authMsg.style.color = isError ? "#b42318" : "#72604a";
}

function setTwoFaMessage(text, isError = false) {
  twoFaMsg.textContent = text;
  twoFaMsg.style.color = isError ? "#b42318" : "#72604a";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("ar-MA");
  } catch {
    return "-";
  }
}

function saveTokens(tokens) {
  sessionStorage.setItem(tokenStorageKey, JSON.stringify(tokens));
}

function loadTokens() {
  const raw = sessionStorage.getItem(tokenStorageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearTokens() {
  sessionStorage.removeItem(tokenStorageKey);
}

function resetProtectedTables() {
  rows.innerHTML = `<tr><td colspan="10" class="empty">لا توجد بيانات بعد</td></tr>`;
  auditRows.innerHTML = `<tr><td colspan="5" class="empty">لا توجد سجلات تدقيق</td></tr>`;
}

function setAuthenticatedUI(isAuthenticated) {
  if (isAuthenticated) {
    protectedArea.classList.remove("hidden");
    securityCard.classList.remove("hidden");
    return;
  }
  protectedArea.classList.add("hidden");
  securityCard.classList.add("hidden");
  renderQrCode("");
  twoFaUriEl.textContent = "";
  resetProtectedTables();
}

async function login() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const twoFactorCode = otpCodeInput.value.trim();

  if (!username || !password) {
    setAuthMessage("أدخل اسم المستخدم وكلمة المرور.", true);
    return;
  }

  loginBtn.disabled = true;
  setAuthMessage("جاري تسجيل الدخول...");

  try {
    const res = await fetch(apiUrl("/api/v1/admin/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, twoFactorCode })
    });

    if (res.status === 202) {
      setAuthMessage("الحساب يتطلب رمز 2FA. أدخل الرمز وأعد المحاولة.", true);
      return;
    }
    if (res.status === 423) {
      setAuthMessage("الحساب مقفل مؤقتًا بسبب محاولات فاشلة كثيرة.", true);
      return;
    }
    if (!res.ok) {
      throw new Error("login_failed");
    }

    const data = await res.json();
    saveTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken
    });
    setAuthenticatedUI(true);
    setAuthMessage(`تم تسجيل الدخول: ${data.user.username}`);
    passwordInput.value = "";
    otpCodeInput.value = "";
    await fetchLeads();
    await fetchAuditLogs();
  } catch {
    clearTokens();
    setAuthenticatedUI(false);
    setAuthMessage("فشل تسجيل الدخول. تحقق من البيانات.", true);
  } finally {
    loginBtn.disabled = false;
  }
}

async function refreshSession() {
  const tokens = loadTokens();
  if (!tokens?.refreshToken) return false;

  const res = await fetch(apiUrl("/api/v1/admin/auth/refresh"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: tokens.refreshToken })
  });

  if (!res.ok) {
    clearTokens();
    return false;
  }

  const data = await res.json();
  saveTokens({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken
  });
  return true;
}

async function authorizedFetch(url, options = {}, allowRefresh = true) {
  const tokens = loadTokens();
  if (!tokens?.accessToken) {
    throw new Error("not_logged_in");
  }

  const merged = {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${tokens.accessToken}`
    }
  };

  let res = await fetch(apiUrl(url), merged);
  if (res.status === 401 && allowRefresh) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      throw new Error("session_expired");
    }
    res = await authorizedFetch(url, options, false);
  }
  return res;
}

async function fetchLeads() {
  setMessage("جاري تحميل الطلبات...");
  loadBtn.disabled = true;

  const filter = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : "";
  try {
    const res = await authorizedFetch(`/api/v1/admin/leads${filter}`);
    if (!res.ok) {
      throw new Error("request_failed");
    }

    const data = await res.json();
    renderRows(data.items || []);
    setMessage(`تم تحميل ${data.count || 0} طلب بنجاح.`);
  } catch (error) {
    if (error.message === "not_logged_in" || error.message === "session_expired") {
      setMessage("سجّل الدخول أولًا.", true);
      setAuthMessage("انتهت الجلسة. سجل الدخول مجددًا.", true);
      clearTokens();
      setAuthenticatedUI(false);
      return;
    }
    setMessage("تعذر تحميل البيانات.", true);
  } finally {
    loadBtn.disabled = false;
  }
}

function renderRows(items) {
  if (!items.length) {
    rows.innerHTML = `<tr><td colspan="10" class="empty">لا توجد طلبات</td></tr>`;
    return;
  }

  rows.innerHTML = items.map((item) => {
    const statusSelect = `
      <select class="status-select" data-id="${item.id}">
        ${statusOptions
          .map((s) => `<option value="${s.value}" ${item.status === s.value ? "selected" : ""}>${s.label}</option>`)
          .join("")}
      </select>
    `;
    const updateBtn = `<button type="button" class="update-btn" data-id="${item.id}">حفظ القرار</button>`;

    return `
      <tr>
        <td>${esc(item.id)}</td>
        <td>${esc(formatDate(item.created_at))}</td>
        <td>${esc(item.full_name)}</td>
        <td>${esc(item.phone)}</td>
        <td>${esc(item.city || "-")}</td>
        <td>${esc(item.product_type)}</td>
        <td>${esc(item.budget_range || "-")}</td>
        <td>${esc(item.details || "-")}</td>
        <td><span class="status-pill ${esc(item.status)}">${esc(getStatusLabel(item.status))}</span></td>
        <td>${statusSelect} ${updateBtn}</td>
      </tr>
    `;
  }).join("");
}

async function updateStatus(leadId) {
  const selector = document.querySelector(`.status-select[data-id="${leadId}"]`);
  if (!selector) return;

  const nextStatus = selector.value;
  setMessage(`جاري تحديث القرار للطلب رقم ${leadId}...`);

  try {
    const res = await authorizedFetch(`/api/v1/admin/leads/${leadId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: nextStatus,
        note: "تم التحديث من لوحة الإدارة"
      })
    });

    if (!res.ok) {
      throw new Error("update_failed");
    }

    setMessage(`تم تحديث حالة الطلب رقم ${leadId} إلى "${getStatusLabel(nextStatus)}".`);
    await fetchLeads();
    await fetchAuditLogs();
  } catch (error) {
    if (error.message === "not_logged_in" || error.message === "session_expired") {
      setMessage("سجّل الدخول أولًا.", true);
      clearTokens();
      setAuthenticatedUI(false);
      return;
    }
    setMessage("تعذر تحديث الحالة.", true);
  }
}

function renderAuditRows(items) {
  if (!items.length) {
    auditRows.innerHTML = `<tr><td colspan="5" class="empty">لا توجد سجلات تدقيق</td></tr>`;
    return;
  }

  auditRows.innerHTML = items.map((item) => `
    <tr>
      <td>${esc(item.id)}</td>
      <td>${esc(formatDate(item.created_at))}</td>
      <td>${esc(getAuditLabel(item.action))}</td>
      <td>${esc(item.user_id ?? "-")}</td>
      <td>${esc(item.ip_address ?? "-")}</td>
    </tr>
  `).join("");
}

async function fetchAuditLogs() {
  try {
    const res = await authorizedFetch("/api/v1/admin/audit-logs?limit=30");
    if (!res.ok) return;
    const data = await res.json();
    renderAuditRows(data.items || []);
  } catch {
    // no-op
  }
}

async function setup2fa() {
  try {
    const res = await authorizedFetch("/api/v1/admin/auth/2fa/setup", { method: "GET" });
    if (!res.ok) throw new Error("setup_failed");
    const data = await res.json();
    twoFaSecretInput.value = data.secret || "";
    twoFaUriEl.textContent = data.otpauthUrl || "";
    renderQrCode(data.otpauthUrl || "");
    setTwoFaMessage("تم إنشاء رمز QR بنجاح. امسحه بالتطبيق ثم أدخل الكود للتفعيل.");
  } catch {
    setTwoFaMessage("تعذر تهيئة 2FA. تأكد من تسجيل الدخول.", true);
  }
}

async function enable2fa() {
  const secret = twoFaSecretInput.value.trim();
  const code = twoFaCodeInput.value.trim();
  if (!secret || !code) {
    setTwoFaMessage("الكود السري ورمز التطبيق مطلوبان.", true);
    return;
  }

  try {
    const res = await authorizedFetch("/api/v1/admin/auth/2fa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, code })
    });
    if (!res.ok) throw new Error("enable_failed");
    setTwoFaMessage("تم تفعيل الحماية الثنائية بنجاح.");
    twoFaCodeInput.value = "";
    await fetchAuditLogs();
  } catch {
    setTwoFaMessage("فشل تفعيل 2FA. تحقق من الكود.", true);
  }
}

async function disable2fa() {
  const code = twoFaCodeInput.value.trim();
  if (!code) {
    setTwoFaMessage("أدخل كود 2FA لتعطيله.", true);
    return;
  }

  try {
    const res = await authorizedFetch("/api/v1/admin/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) throw new Error("disable_failed");
    setTwoFaMessage("تم تعطيل الحماية الثنائية.");
    twoFaCodeInput.value = "";
    twoFaSecretInput.value = "";
    twoFaUriEl.textContent = "";
    renderQrCode("");
    await fetchAuditLogs();
  } catch {
    setTwoFaMessage("فشل تعطيل 2FA. تحقق من الكود.", true);
  }
}

async function logout() {
  const tokens = loadTokens();
  if (tokens?.refreshToken) {
    try {
      await fetch(apiUrl("/api/v1/admin/auth/logout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken })
      });
    } catch {
      // ignore network errors on logout
    }
  }

  clearTokens();
  setAuthenticatedUI(false);
  setAuthMessage("تم تسجيل الخروج.");
  setMessage("تم تسجيل الخروج.");
}

rows.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains("update-btn")) return;

  const id = Number(target.dataset.id);
  if (!Number.isInteger(id) || id <= 0) return;
  void updateStatus(id);
});

loginBtn.addEventListener("click", () => {
  void login();
});

logoutBtn.addEventListener("click", () => {
  void logout();
});

loadBtn.addEventListener("click", () => {
  void fetchLeads();
  void fetchAuditLogs();
});

setup2faBtn.addEventListener("click", () => {
  void setup2fa();
});

enable2faBtn.addEventListener("click", () => {
  void enable2fa();
});

disable2faBtn.addEventListener("click", () => {
  void disable2fa();
});

async function initializeSession() {
  setAuthenticatedUI(false);
  if (!loadTokens()) {
    return;
  }

  try {
    const res = await authorizedFetch("/api/v1/admin/auth/me");
    if (!res.ok) {
      throw new Error("invalid_session");
    }
    setAuthenticatedUI(true);
    setAuthMessage("تم التحقق من الجلسة. يمكنك إدارة الطلبات.");
    await fetchLeads();
    await fetchAuditLogs();
  } catch {
    clearTokens();
    setAuthenticatedUI(false);
    setAuthMessage("انتهت الجلسة. سجل الدخول من جديد.", true);
  }
}

void initializeSession();
