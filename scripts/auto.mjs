#!/usr/bin/env node
// SmartCare automation: one command for setup, start and health checks. No dependencies (Node 18.18+).
//
//   npm run auto            -> setup (idempotent) + start web + api + agents (+ MongoDB via Docker if needed)
//   npm run auto:setup      -> only prepare .env files, install packages, start MongoDB
//   npm run doctor          -> check everything and test the Groq key
//
// Flags: --skip-install  --no-agents  --no-mongo
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...a) => path.join(ROOT, ...a);
const isWin = process.platform === 'win32';
const args = new Set(process.argv.slice(3));
const cmd = process.argv[2] || 'start';

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const ok = (m) => console.log(`${c.g('✔')} ${m}`);
const warn = (m) => console.log(`${c.y('!')} ${m}`);
const bad = (m) => console.log(`${c.r('✘')} ${m}`);
const info = (m) => console.log(`${c.d('·')} ${m}`);
const rand = (n = 32) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- env files
const parse = (txt) => Object.fromEntries([...txt.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2].replace(/\r$/, '')]));
const getVal = (file, key) => (fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8'))[key] ?? '' : '');

function setKey(file, key, value) {
  let t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  t = re.test(t) ? t.replace(re, `${key}=${value}`) : t.replace(/\s*$/, '\n') + `${key}=${value}\n`;
  fs.writeFileSync(file, t);
}

// Create .env from .env.example if missing; always append keys that newer versions added (never overwrite yours).
function ensureEnv(dir, onCreate) {
  const env = P(dir, '.env');
  const ex = P(dir, '.env.example');
  if (!fs.existsSync(ex)) return false;
  if (!fs.existsSync(env)) {
    fs.copyFileSync(ex, env);
    onCreate?.(env);
    ok(`${dir}/.env created from .env.example`);
    return true;
  }
  const have = parse(fs.readFileSync(env, 'utf8'));
  const missing = Object.entries(parse(fs.readFileSync(ex, 'utf8'))).filter(([k]) => !(k in have));
  if (missing.length) {
    fs.appendFileSync(env, '\n# ---- added by npm run auto (new in this version) ----\n' + missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    ok(`${dir}/.env: added ${missing.map(([k]) => k).join(', ')}`);
  }
  return false;
}

function prepareEnvFiles() {
  const serverEnv = P('server', '.env');
  ensureEnv('server', (f) => {
    setKey(f, 'JWT_SECRET', rand(48));
    const pass = 'Sc@' + rand(6);
    setKey(f, 'ADMIN_PASSWORD', pass);
    // No Razorpay account needed for a first run: practice payment window.
    if (!getVal(f, 'RAZORPAY_KEY_ID') || getVal(f, 'RAZORPAY_KEY_ID').includes('your_')) setKey(f, 'PAYMENT_MODE', 'demo');
    console.log(`  ${c.b('Staff login')} → username: ${c.b(getVal(f, 'ADMIN_USERNAME') || 'admin')}   password: ${c.b(pass)}   ${c.d('(saved in server/.env)')}`);
  });
  // An old/blank JWT secret would stop the server at start: fix it automatically.
  const jwt = getVal(serverEnv, 'JWT_SECRET');
  if (jwt.length < 16 || jwt.startsWith('change-me')) {
    setKey(serverEnv, 'JWT_SECRET', rand(48));
    ok('server/.env: generated a strong JWT_SECRET');
  }
  ensureEnv('agents', (f) => {
    setKey(f, 'AGENT_SEED_PHRASE', rand(24));
    setKey(f, 'USE_MAILBOX', 'false'); // mailbox needs a one-time Agentverse sign-in; local mode works out of the box
  });
  const agentsEnv = P('agents', '.env');
  if (fs.existsSync(agentsEnv)) {
    // Put the Groq key in ONE place (server/.env); the agents get a copy automatically.
    for (const k of ['GROQ_API_KEY', 'GROQ_MODEL']) {
      const v = getVal(serverEnv, k);
      if (v && getVal(agentsEnv, k) !== v) {
        setKey(agentsEnv, k, v);
        ok(`agents/.env: ${k} synced from server/.env`);
      }
    }
  }
}

// ---------------------------------------------------------------- helpers
const which = (bin) => spawnSync(isWin ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
const run = (bin, a, opts = {}) => spawnSync(bin, a, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
const quiet = (bin, a, opts = {}) => spawnSync(bin, a, { cwd: ROOT, encoding: 'utf8', shell: isWin, ...opts });

function portOpen(port, host = '127.0.0.1', ms = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function pythonBin() {
  const venv = isWin ? P('agents', '.venv', 'Scripts', 'python.exe') : P('agents', '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return ['python3', 'python', 'py'].find((b) => which(b) && quiet(b, ['--version']).status === 0) || null;
}

const mongoUri = () => getVal(P('server', '.env'), 'MONGODB_URI') || 'mongodb://127.0.0.1:27017/smartcare';
const mongoIsLocal = () => /mongodb:\/\/(127\.0\.0\.1|localhost)/.test(mongoUri());

async function ensureMongo() {
  if (args.has('--no-mongo') || !mongoIsLocal()) return info('MongoDB: using the remote URI from server/.env');
  if (await portOpen(27017)) return ok('MongoDB is running on :27017');
  if (!which('docker')) return warn('MongoDB is not running and Docker is not installed. Start MongoDB yourself or put an Atlas URI in server/.env (MONGODB_URI).');
  info('Starting MongoDB with Docker…');
  run('docker', ['compose', 'up', '-d', 'mongo']);
  for (let i = 0; i < 30; i++) {
    if (await portOpen(27017)) return ok('MongoDB started');
    await sleep(1000);
  }
  warn('MongoDB did not come up in 30s. Check: docker compose logs mongo');
}

function installNode() {
  if (args.has('--skip-install')) return;
  if (!fs.existsSync(P('node_modules'))) { info('Installing web packages…'); if (run('npm', ['install']).status !== 0) throw new Error('npm install failed'); } else ok('Web packages installed');
  if (!fs.existsSync(P('server', 'node_modules'))) { info('Installing server packages…'); if (run('npm', ['--prefix', 'server', 'install']).status !== 0) throw new Error('server npm install failed'); } else ok('Server packages installed');
}

// Returns true when the Python agents can run.
function installAgents() {
  if (args.has('--no-agents')) return false;
  const py = pythonBin();
  if (!py) { warn('Python 3 not found: AI agents skipped (web + API still work, chatbot uses Groq / rules).'); return false; }
  const has = quiet(py, ['-c', 'import uagents, httpx, dotenv']).status === 0;
  if (has) { ok('Python agent packages installed'); return true; }
  if (args.has('--skip-install')) { warn('Agent packages missing (skipped install).'); return false; }
  info('Setting up Python agents (virtual env + pip)…');
  const venvDir = P('agents', '.venv');
  if (!fs.existsSync(venvDir) && run(py, ['-m', 'venv', venvDir]).status !== 0) { warn('Could not create a Python venv: agents skipped.'); return false; }
  const vpy = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  if (run(vpy, ['-m', 'pip', 'install', '-q', '-r', P('agents', 'requirements.txt')]).status !== 0) { warn('pip install failed: agents skipped.'); return false; }
  ok('Python agents ready');
  return true;
}

async function setup() {
  console.log(c.b('\nSmartCare setup\n'));
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { bad(`Node ${process.versions.node} is too old (need 18.18+).`); process.exit(1); }
  prepareEnvFiles();
  installNode();
  const agents = installAgents();
  await ensureMongo();
  const key = getVal(P('server', '.env'), 'GROQ_API_KEY');
  if (!key) warn(`Groq AI is off. Free key: https://console.groq.com/keys  → put it in server/.env as GROQ_API_KEY=… (agents get it automatically)`);
  else ok('Groq key found');
  return { agents };
}

// ---------------------------------------------------------------- start everything
function startAll({ agents }) {
  const procs = [];
  const colors = { web: '\x1b[36m', api: '\x1b[32m', agents: '\x1b[35m' };
  const launch = (name, bin, a, opts = {}) => {
    const p = spawn(bin, a, { cwd: ROOT, shell: isWin, env: { ...process.env, FORCE_COLOR: '1' }, ...opts });
    const pipe = (s) => (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => s.write(`${colors[name]}[${name}]\x1b[0m ${l}\n`));
    p.stdout.on('data', pipe(process.stdout));
    p.stderr.on('data', pipe(process.stderr));
    p.on('exit', (code) => { if (!stopping) { bad(`${name} stopped (code ${code}).`); if (name !== 'agents') stop(1); } });
    procs.push(p);
  };
  let stopping = false;
  const stop = (code = 0) => { stopping = true; procs.forEach((p) => { try { isWin ? spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F']) : p.kill('SIGTERM'); } catch { /* already gone */ } }); setTimeout(() => process.exit(code), 400); };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  launch('api', 'npm', ['--prefix', 'server', 'run', 'dev']);
  launch('web', 'npm', ['run', 'dev']);
  if (agents) launch('agents', pythonBin(), [P('agents', 'run_all.py')]);

  setTimeout(() => {
    console.log(`\n${c.b('SmartCare is starting')}\n  Website : ${c.b('http://localhost:5173')}\n  API     : http://localhost:5000/api/health\n  Check   : npm run doctor      Stop: Ctrl+C\n`);
  }, 1500);
}

// ---------------------------------------------------------------- doctor
async function doctor() {
  console.log(c.b('\nSmartCare doctor\n'));
  let bads = 0;
  const check = (cond, good, fail, level = 'bad') => { if (cond) ok(good); else { (level === 'warn' ? warn : bad)(fail); if (level === 'bad') bads++; } };

  check(Number(process.versions.node.split('.')[0]) >= 18, `Node ${process.versions.node}`, `Node ${process.versions.node} is too old (need 18.18+)`);
  const sEnv = P('server', '.env');
  check(fs.existsSync(sEnv), 'server/.env exists', 'server/.env missing → run: npm run auto:setup');
  check(getVal(sEnv, 'JWT_SECRET').length >= 16, 'JWT_SECRET is set', 'JWT_SECRET missing/short → run: npm run auto:setup');
  check(fs.existsSync(P('node_modules')) && fs.existsSync(P('server', 'node_modules')), 'npm packages installed', 'packages missing → run: npm run auto:setup');
  check(await portOpen(27017), 'MongoDB reachable on :27017', 'MongoDB not reachable on :27017 (fine if you use Atlas) → docker compose up -d mongo', mongoIsLocal() ? 'bad' : 'warn');

  // Live Groq test
  const key = getVal(sEnv, 'GROQ_API_KEY');
  const model = getVal(sEnv, 'GROQ_MODEL') || 'openai/gpt-oss-120b';
  if (!key) warn('GROQ_API_KEY not set (Groq AI off) → https://console.groq.com/keys');
  else {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) ok(`Groq works (model ${model})`);
      else { bad(`Groq returned ${r.status}: ${r.status === 401 ? 'key is invalid' : r.status === 404 ? 'model name not found' : 'see https://console.groq.com'}`); bads++; }
    } catch { warn('Could not reach api.groq.com (offline?)'); }
  }

  const py = pythonBin();
  if (!py) warn('Python not found (AI agents off)');
  else check(quiet(py, ['-c', 'import uagents']).status === 0, 'Python agent packages installed', 'agent packages missing → run: npm run auto:setup', 'warn');

  // Running services
  try {
    const h = await (await fetch('http://localhost:5000/api/health', { signal: AbortSignal.timeout(3000) })).json();
    ok(`API running · database ${h.database ? 'connected' : c.r('NOT connected')} · groq ${h.groq ? 'on' : 'off'} · agent ${h.agent ? 'on' : 'off'} · payments ${h.paymentMode}`);
    if (!h.database) bads++;
  } catch { info('API is not running right now (start it with: npm run auto)'); }
  console.log(bads ? `\n${c.r(`${bads} problem(s) found.`)}\n` : `\n${c.g('All good.')}\n`);
  process.exit(bads ? 1 : 0);
}

// ---------------------------------------------------------------- main
try {
  if (cmd === 'setup') { await setup(); console.log(`\n${c.g('Setup done.')} Start everything with: ${c.b('npm run auto')}\n`); }
  else if (cmd === 'doctor') await doctor();
  else if (cmd === 'start') startAll(await setup());
  else { console.log('Usage: node scripts/auto.mjs [setup|start|doctor] [--skip-install] [--no-agents] [--no-mongo]'); process.exit(1); }
} catch (e) {
  bad(e.message);
  process.exit(1);
}
