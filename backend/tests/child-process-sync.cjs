/* eslint-disable no-param-reassign */
// Vitest (via Vite) calls `child_process.exec("net use")` on Windows.
// In this environment async spawning is blocked (EPERM), but sync spawning works.
// Patch exec/execFile to use sync equivalents so tests can run.

const cp = require("node:child_process");

// Provide minimal defaults so importing the app in tests doesn't require a real env file.
process.env.JWT_SECRET ??= "test_jwt_secret_123";
process.env.ACCESS_TOKEN_TTL_SECONDS ??= "900";
process.env.REFRESH_TOKEN_DAYS ??= "7";
process.env.ADMIN_USERNAME ??= "admin";
process.env.ADMIN_PASSWORD ??= "AdminPass123456!";
process.env.ADMIN_SYNC_PASSWORD_ON_START ??= "false";
process.env.TURNSTILE_ENABLED ??= "false";

const originalExecSync = cp.execSync.bind(cp);
const originalExecFileSync = cp.execFileSync.bind(cp);

cp.exec = function patchedExec(command, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === "function") {
    cb = opts;
    opts = undefined;
  }
  const resolvedOptions = typeof opts === "object" && opts !== null ? { ...opts } : {};
  const encoding = resolvedOptions.encoding ?? "utf8";
  resolvedOptions.encoding = encoding;

  try {
    const stdout = originalExecSync(command, resolvedOptions);
    if (typeof cb === "function") process.nextTick(cb, null, stdout, "");
    return { pid: 0 };
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    const stderr = error?.stderr?.toString?.() ?? "";
    if (typeof cb === "function") process.nextTick(cb, error, stdout, stderr);
    return { pid: 0 };
  }
};

cp.execFile = function patchedExecFile(file, args, options, callback) {
  let fileArgs = args;
  let opts = options;
  let cb = callback;

  if (typeof fileArgs === "function") {
    cb = fileArgs;
    fileArgs = [];
    opts = undefined;
  } else if (typeof opts === "function") {
    cb = opts;
    opts = undefined;
  }

  const resolvedArgs = Array.isArray(fileArgs) ? fileArgs : [];
  const resolvedOptions = typeof opts === "object" && opts !== null ? { ...opts } : {};
  const encoding = resolvedOptions.encoding ?? "utf8";
  resolvedOptions.encoding = encoding;

  try {
    const stdout = originalExecFileSync(file, resolvedArgs, resolvedOptions);
    if (typeof cb === "function") process.nextTick(cb, null, stdout, "");
    return { pid: 0 };
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    const stderr = error?.stderr?.toString?.() ?? "";
    if (typeof cb === "function") process.nextTick(cb, error, stdout, stderr);
    return { pid: 0 };
  }
};

